// One-off helper: patch package-lock.json so it carries the platform-specific
// optional deps for every OS, not just the one it was generated on.
//
// Why: npm (as of v10) writes only the optional deps matching the build OS,
// so a Windows-generated lock makes `npm ci` fail on Linux with
// "Cannot find module @rollup/rollup-linux-x64-gnu" (npm/cli#4828).
//
// Strategy: read the full optionalDependencies list from the rollup package
// entry, fetch integrity + resolved from the registry for any missing entry,
// and write it back.
import { readFile, writeFile } from 'node:fs/promises';

const LOCK = './package-lock.json';
const lock = JSON.parse(await readFile(LOCK, 'utf-8'));

/** Package whose optionalDependencies enumerate every platform variant. */
const PARENTS = [
  { parent: 'node_modules/rollup', scope: '@rollup/rollup-' },
  { parent: 'node_modules/rollup', scope: '@napi-rs/lzma-' }
];

/**
 * Optional deps that are not listed under an optionalDependencies block we
 * scan (npm omits them entirely when the lock is generated off-platform).
 * key → version range as declared by the depending package.
 */
const EXTRA_OPTIONAL = {
  fsevents: '~2.3.2'
};

const registryOverride = process.env.NPM_REGISTRY || 'https://registry.npmjs.org';

async function fetchMeta(name, version) {
  const url = `${registryOverride}/${name.replace('/', '%2f')}/${version}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`registry ${res.status} for ${name}@${version}`);
  }
  const meta = await res.json();
  return {
    tarball: meta.dist.tarball,
    integrity: meta.dist.integrity,
    // Registry metadata is authoritative for platform constraints — more
    // reliable than parsing them out of the package name.
    os: meta.os,
    cpu: meta.cpu
  };
}

/**
 * Resolve a semver range to the highest published version that satisfies it.
 * Needed because a range like `~2.3.2` must resolve to 2.3.3, not to the
 * literal `2.3.2` — `npm ci` rejects the lock otherwise.
 */
async function resolveVersion(name, range) {
  const url = `${registryOverride}/${name.replace('/', '%2f')}`;
  const res = await fetch(url, { headers: { Accept: 'application/vnd.npm.install-v1+json' } });
  if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
  const meta = await res.json();
  const versions = Object.keys(meta.versions || {}).filter(
    (v) => !v.includes('-') // skip prereleases
  );

  const parts = range.replace(/^[\^~>=<\s]+/, '');
  const [maj, min, pat] = parts.split('.').map((n) => parseInt(n, 10));
  const clean = range.trim();

  const matches = versions.filter((v) => {
    const [a, b, c] = v.split('.').map((n) => parseInt(n, 10));
    if (clean.startsWith('^')) {
      if (maj !== 0) return a === maj && (b > min || (b === min && c >= pat));
      if (min !== 0) return a === 0 && b === min && c >= pat;
      return a === 0 && b === 0 && c === pat;
    }
    if (clean.startsWith('~')) {
      return a === maj && b === min && c >= pat;
    }
    return v === parts;
  });

  // Highest satisfying version wins.
  matches.sort((x, y) => {
    const [x1, x2, x3] = x.split('.').map(Number);
    const [y1, y2, y3] = y.split('.').map(Number);
    return y1 - x1 || y2 - x2 || y3 - x3;
  });

  if (matches.length === 0) throw new Error(`no version satisfies ${name}@${range}`);
  return matches[0];
}

let added = 0;

for (const { parent, scope } of PARENTS) {
  const parentPkg = lock.packages[parent];
  if (!parentPkg) {
    console.warn(`skip: ${parent} not in lock`);
    continue;
  }
  const optDeps = parentPkg.optionalDependencies || {};

  for (const [depName, depRange] of Object.entries(optDeps)) {
    if (!depName.startsWith(scope)) continue;
    const key = `node_modules/${depName}`;
    if (lock.packages[key]) continue; // already present

    const version = await resolveVersion(depName, depRange);
    const meta = await fetchMeta(depName, version);

    lock.packages[key] = {
      version,
      resolved: meta.tarball,
      integrity: meta.integrity,
      ...(meta.cpu ? { cpu: meta.cpu } : {}),
      dev: true,
      license: 'MIT',
      optional: true,
      ...(meta.os ? { os: meta.os } : {})
    };
    added++;
    console.log(
      `added ${depName}@${version} (os=${(meta.os || []).join(',') || '-'} cpu=${(meta.cpu || []).join(',') || '-'})`
    );
  }
}

// Handle optional deps npm drops entirely when the lock is built off-platform.
for (const [depName, depRange] of Object.entries(EXTRA_OPTIONAL)) {
  const key = `node_modules/${depName}`;
  if (lock.packages[key]) continue;

  const version = await resolveVersion(depName, depRange);
  const meta = await fetchMeta(depName, version);
  lock.packages[key] = {
    version,
    resolved: meta.tarball,
    integrity: meta.integrity,
    ...(meta.cpu ? { cpu: meta.cpu } : {}),
    dev: true,
    license: 'MIT',
    optional: true,
    ...(meta.os ? { os: meta.os } : {})
  };
  added++;
  console.log(
    `added ${depName}@${version} (os=${(meta.os || []).join(',') || '-'} cpu=${(meta.cpu || []).join(',') || '-'})`
  );
}

if (added > 0) {
  const sorted = {};
  for (const k of Object.keys(lock.packages).sort()) sorted[k] = lock.packages[k];
  lock.packages = sorted;
  await writeFile(LOCK, JSON.stringify(lock, null, 2) + '\n');
  console.log(`\npatched ${added} entries → ${LOCK}`);
} else {
  console.log('nothing to add');
}
