import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Regression guard for the container startup bug.
 *
 * The ENTRYPOINT used the *shell* form:
 *   ENTRYPOINT ["/bin/sh", "-c", "if [...]; then exec node ... \"$@\"; fi"]
 *
 * Docker appends CMD as arguments to `sh -c`, and sh assigns the FIRST of them
 * to $0. With `CMD ["--web", "--host", "0.0.0.0", "--port", "3000"]`, `--web`
 * became the script name and never reached node — the CLI then ran in pipeline
 * mode and exited with "error: no URLs provided".
 *
 * These tests assert the Dockerfile keeps the exec form, which passes every
 * argument through untouched.
 */
const DOCKERFILE = join(process.cwd(), 'Dockerfile');

async function readDockerfile(): Promise<string> {
  return readFile(DOCKERFILE, 'utf-8');
}

/** Extract the parsed JSON array of an instruction, ignoring comments. */
function parseJsonInstruction(source: string, instruction: string): string[] | null {
  const re = new RegExp(`^${instruction}\\s+(\\[.*\\])\\s*$`, 'm');
  const match = source.match(re);
  if (!match) return null;
  return JSON.parse(match[1]) as string[];
}

describe('Dockerfile entrypoint', () => {
  it('uses the exec form for ENTRYPOINT, not a shell wrapper', async () => {
    const source = await readDockerfile();
    const entrypoint = parseJsonInstruction(source, 'ENTRYPOINT');

    expect(entrypoint).not.toBeNull();
    // A shell wrapper would surface as /bin/sh here and swallow the first arg.
    expect(entrypoint).not.toContain('/bin/sh');
    expect(entrypoint?.[0]).toBe('/sbin/dumb-init');
    expect(entrypoint?.[1]).toBe('--');
    expect(entrypoint?.[2]).toBe('node');
    expect(entrypoint?.[3]).toBe('/app/dist/index.js');
  });

  it('never wraps ENTRYPOINT/CMD in sh -c', async () => {
    const source = await readDockerfile();
    // Strip comment lines before scanning for the anti-pattern.
    const body = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(body).not.toMatch(/ENTRYPOINT\s+\[\s*"\/bin\/sh"/);
    expect(body).not.toMatch(/CMD\s+\[\s*"\/bin\/sh"/);
    // The "$@" expansion only makes sense inside a shell wrapper — its presence
    // in an instruction line means the shell form crept back in.
    expect(body).not.toMatch(/ENTRYPOINT.*\$\@/);
  });

  it('defaults CMD to the web UI bound on all interfaces', async () => {
    const source = await readDockerfile();
    const cmd = parseJsonInstruction(source, 'CMD');

    expect(cmd).not.toBeNull();
    expect(cmd).toContain('--web');
    expect(cmd).toContain('--host');
    // 0.0.0.0 is required: 127.0.0.1 is unreachable through Docker's port map.
    expect(cmd).toContain('0.0.0.0');
  });

  it('guarantees dumb-init exists at the path the entrypoint uses', async () => {
    const source = await readDockerfile();
    // The entrypoint hard-codes /sbin/dumb-init, so the build must create it.
    expect(source).toMatch(/apk add[^\n]*dumb-init/);
    expect(source).toMatch(/ln -sf\s+\/usr\/bin\/dumb-init\s+\/sbin\/dumb-init/);
  });
});
