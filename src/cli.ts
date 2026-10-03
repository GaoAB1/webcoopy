import { Command } from 'commander';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { processMany, defaultAdapters, type PipelineOptions } from './pipeline.js';
import { fetchHtml, FetchError } from './fetcher.js';
import { extractArticle } from './extractor.js';
import { startServer, type WebServerOptions } from './web.js';

/** Kept in sync with package.json — surfaced by `--version` and `--doctor`. */
export const CLI_VERSION = '0.1.0';

export interface CliDeps {
  /** Injectable for tests. */
  runPipeline?: (urls: string[], options: PipelineOptions) => Promise<ReturnType<typeof processMany>>;
  /** Injectable for tests. */
  startWebServer?: (options: WebServerOptions) => Promise<{ port: number; close: () => Promise<void> }>;
}

export function buildCli(deps: CliDeps = {}): Command {
  const program = new Command();
  const runPipeline = deps.runPipeline ?? processMany;
  const startWeb = deps.startWebServer ?? (async (opts) => {
    const s = await startServer(opts);
    return { port: s.port, close: s.close };
  });

  program
    .name('webcopy')
    .description('Fetch a URL and convert the article body to faithful Markdown.')
    .version(CLI_VERSION)
    .argument('[urls...]', 'one or more article URLs (omit when using --web)')
    .option('-o, --out <dir>', 'output directory', './output')
    .option('--file <path>', 'read URLs from a file (one per line, # comments supported)')
    .option('--overwrite', 'overwrite existing files', false)
    .option('-v, --verbose', 'print debug info', false)
    .option('--timeout <ms>', 'request timeout in ms', (v) => Number(v), 15000)
    .option('--retries <n>', 'total attempts on transient errors', (v) => Number(v), 3)
    .option('--no-adapters', 'disable platform-specific adapters (GitHub README, Zhihu, …)')
    .option('--localize-images', 'download remote images to ./images/ and rewrite URLs', false)
    .option('--image-max-bytes <bytes>', 'max image size in bytes; larger images are skipped', (v) => Number(v))
    .option('--image-concurrency <n>', 'max images to download in parallel (default 4; set 1 for serial)', (v) => Number(v))
    .option('--web', 'start the web UI server instead of the CLI pipeline', false)
    .option('--host <host>', 'bind address for --web', '127.0.0.1')
    .option('--port <port>', 'port for --web', (v) => Number(v), 3000)
    .option('--doctor', 'print build info and adapter capabilities, then exit', false)
    .option(
      '--dump-html [dir]',
      'with --doctor <url>: save the raw fetched HTML for inspection'
    )
    .action(async (urls: string[], opts) => {
      if (opts.doctor) {
        printDoctor();
        // With URLs supplied, also probe the live fetch path so a single
        // command can distinguish "stale build" from "site changed".
        if (urls.length > 0) {
          await probeUrls(urls, opts);
        }
        return;
      }      if (opts.web) {
        await runWebServer(opts, startWeb);
        return;
      }
      const fromFile = await readUrlsFromFile(opts.file);
      const allUrls = [...urls, ...fromFile];

      if (allUrls.length === 0) {
        console.error('error: no URLs provided. Pass URLs as arguments or use --file.');
        process.exitCode = 2;
        return;
      }

      const imageOptions: Record<string, number> = {};
      if (typeof opts.imageMaxBytes === 'number') {
        imageOptions.maxBytes = opts.imageMaxBytes;
      }
      if (typeof opts.imageConcurrency === 'number') {
        imageOptions.concurrency = opts.imageConcurrency;
      }

      const options: PipelineOptions = {
        outDir: opts.out,
        overwrite: !!opts.overwrite,
        verbose: !!opts.verbose,
        disableAdapters: !opts.adapters,
        localizeImages: !!opts.localizeImages,
        imageOptions,
        fetch: {
          timeoutMs: opts.timeout,
          retries: opts.retries
        }
      };

      const results = await runPipeline(allUrls, options);

      let failed = 0;
      for (const r of results) {
        if (r.ok) {
          const adapterNote = r.adapter ? ` (via ${r.adapter})` : '';
          const imagesNote = r.images && (r.images.local + r.images.failed + r.images.skipped > 0)
            ? ` (imgs: ${r.images.local}↓ ${r.images.failed}✗ ${r.images.skipped}~)`
            : '';
          if (r.skipped) {
            console.log(`skipped ${r.url} (exists) → ${r.path}`);
          } else {
            console.log(`wrote  ${r.url} → ${r.path}${adapterNote}${imagesNote}`);
          }
        } else {
          failed++;
          const hint = errorHint(r.errorCode);
          console.error(`failed ${r.url}${hint ? ` [${hint}]` : ''}: ${r.error}`);
        }
      }

      if (failed > 0) {
        process.exitCode = 1;
      }
    });

  return program;
}

async function readUrlsFromFile(path?: string): Promise<string[]> {
  if (!path) return [];
  const raw = await readFile(path, 'utf-8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Diagnostic output for verifying which build is actually running.
 *
 * Mainly exists to settle "I pulled the image but the fix isn't in" confusion:
 * the adapter capability list below is derived from the live adapter objects,
 * so a build that predates the Juejin SSR support reports `dom-only` here.
 */
function printDoctor(): void {
  const registry = defaultAdapters();
  console.log(`webcopy ${CLI_VERSION}`);
  console.log(`node    ${process.version} (${process.platform}/${process.arch})`);
  console.log('');
  console.log('adapters:');
  for (const a of registry.list()) {
    const cap = adapterCapabilities(a);
    console.log(`  ${a.name.padEnd(14)} ${cap.padEnd(22)} ${a.description}`);
  }
  console.log('');
  console.log('If "juejin" above does not say "ssr-payload+dom", the running build');
  console.log('predates the Nuxt SSR payload support — pull the image again.');
  console.log('');
  console.log('Tip: `webcopy --doctor <url>` also fetches the URL and reports which');
  console.log('adapter matched and how large the extracted body was.');
}

/** Report which extraction paths an adapter supports. */
function adapterCapabilities(adapter: { name: string; extract: unknown }): string {
  const probe =
    '<html><head><title>probe</title></head><body>' +
    '<script>window.__NUXT__=(function(a){return {article:{article_info:{mark_content:"probe-body"}}};})(0);</script>' +
    '</body></html>';
  try {
    const r = (adapter as {
      extract: (u: string, h: string, p: string) => { markdown?: string; html?: string } | undefined;
    }).extract('https://juejin.cn/post/1', probe, '');
    if (r && typeof r.markdown === 'string') return 'ssr-payload+dom';
    if (r && typeof r.html === 'string') return 'dom-only';
    return 'dom-only';
  } catch {
    return 'n/a';
  }
}

/**
 * Fetch each URL and report what the pipeline actually produced, without
 * writing anything to disk (unless --dump-html is given). Used by
 * `--doctor <url>` to tell "the build is stale" apart from "the site served a
 * degraded/challenge page".
 *
 * The report includes page-level markers (__NUXT__, mark_content, article
 * content classes, challenge-page signatures) so a failing extraction can be
 * attributed to its layer: transport, anti-bot, payload, DOM, or Readability.
 */
async function probeUrls(
  urls: string[],
  opts: { timeout?: number; retries?: number; dumpHtml?: string }
): Promise<void> {
  const registry = defaultAdapters();
  console.log('');
  console.log('live probe:');

  for (const url of urls) {
    const matched = registry.findFor(url);
    const adapter = matched[0];
    console.log(`  ${url}`);
    console.log(`    adapter: ${adapter?.name ?? '(none — Readability fallback)'}`);

    try {
      const { html, url: finalUrl, status, charset } = await fetchHtml(url, {
        timeoutMs: opts.timeout,
        retries: opts.retries
      });

      console.log(`    fetched:   HTTP ${status}, ${html.length} chars, charset ${charset}`);
      console.log(`    final url: ${finalUrl}`);

      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '(none)';
      console.log(`    title:     ${title}`);

      console.log(`    markers:   ${htmlMarkers(html)}`);

      // Layer 1: adapter extraction.
      let adapterNote = 'no content';
      if (adapter) {
        try {
          const r = await adapter.extract(url, html, finalUrl);
          if (typeof r.markdown === 'string') {
            adapterNote = `markdown ${r.markdown.length} chars`;
          } else if (typeof r.html === 'string') {
            adapterNote = `html ${r.html.length} chars`;
          } else if (r.retryWithBrowser) {
            adapterNote = 'empty — flagged retryWithBrowser (degraded page?)';
          }
        } catch (err) {
          adapterNote = `threw: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      console.log(`    extract:   ${adapterNote}`);

      // Layer 2: Readability.
      const article = extractArticle(html);
      console.log(`    readable:  ${article ? `${article.textContent.trim().length} chars text` : 'no article'}`);

      // Save the raw page whenever the user asked for it (success or not) so
      // it can be compared across machines or attached to a bug report.
      // `--dump-html` without a value arrives as `true` — use the default dir.
      let dumpNote = '';
      if (opts.dumpHtml !== undefined) {
        const dir = typeof opts.dumpHtml === 'string' && opts.dumpHtml.length > 0
          ? opts.dumpHtml
          : './output';
        const dumped = await dumpProbeHtml(url, html, dir);
        dumpNote = dumped ? `; html saved: ${dumped}` : '; html dump failed';
      }

      const ok =
        adapterNote.startsWith('markdown') ||
        adapterNote.startsWith('html') ||
        (article !== null && article.textContent.trim().length >= 100);

      if (ok) {
        console.log(`    RESULT:    ok${dumpNote}`);
      } else {
        console.log(`    RESULT:    FAILED [no-article] ${noArticleHint(html, opts.dumpHtml !== undefined)}${dumpNote}`);
      }
      console.log('');
    } catch (err) {
      if (err instanceof FetchError) {
        console.log(`    RESULT:    FAILED [${err.code}] ${err.message}\n`);
      } else {
        console.log(`    RESULT:    error ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  await rm('./.webcopy-probe', { recursive: true, force: true }).catch(() => {});
}

/** Compact on/off report of the markers that decide where extraction fails. */
function htmlMarkers(html: string): string {
  // NOTE: don't key on secsdk/acrawler — ByteDance sites reference those SDK
  // scripts on every normal page. A real challenge page is tiny (<20KB) and
  // displays a wait/verification message; that combination is the signal.
  const challenge =
    /请稍候|安全验证|captcha|just\s+a\s+moment|please\s+wait/i.test(html) && html.length < 20_000;
  const flags: Array<[string, boolean]> = [
    ['__NUXT__', html.includes('__NUXT__')],
    ['mark_content', html.includes('mark_content')],
    ['article-content', /article-content/i.test(html)],
    ['please-wait', /please\s+wait/i.test(html)],
    ['challenge', challenge]
  ];
  return flags.map(([name, on]) => `${name}${on ? '=yes' : '=no'}`).join('  ');
}

/**
 * A targeted explanation for a no-article result, driven by the markers.
 * A ByteDance-style challenge page is tiny, has no SSR payload, and displays
 * a wait/verification message — that combination, not any single keyword.
 */
function noArticleHint(html: string, dumpEnabled: boolean): string {
  const hasPayload = html.includes('__NUXT__');
  const hasMarkContent = html.includes('mark_content');
  const challenge = /请稍候|安全验证|captcha|just\s+a\s+moment|please\s+wait/i.test(html) && html.length < 20_000;
  const where = dumpEnabled ? 'see the saved .html file' : 're-run with --dump-html to save the page';

  if (challenge) {
    return `the site served an anti-bot challenge page; browser-mode retry did not help — ${where}`;
  }
  if (hasPayload && !hasMarkContent) {
    return `SSR payload present but carries no article data — the site degraded this response for this client; ${where}`;
  }
  if (!hasPayload && !challenge) {
    return `page is not an SPA shell and no article was detected — it may be a non-article page or an unhandled layout; ${where}`;
  }
  return `no readable article detected; ${where}`;
}

/** Save the raw fetched HTML so it can be shared for offline inspection. */
async function dumpProbeHtml(
  url: string,
  html: string,
  dir: string
): Promise<string | undefined> {
  try {
    await mkdir(dir, { recursive: true });
    const slug = urlSafeProbeSlug(url);
    const file = join(dir, `${slug}.html`);
    await writeFile(file, html, 'utf-8');
    return file;
  } catch {
    return undefined;
  }
}

function urlSafeProbeSlug(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? u.hostname.replace(/\./g, '_');
  } catch {
    return 'probe';
  }
}

function errorHint(code?: string): string {
  switch (code) {
    case 'timeout': return 'timeout';
    case 'network': return 'network';
    case 'redirect-loop': return 'redirect-loop';
    case 'http': return 'http';
    case 'unsupported-type': return 'unsupported-type';
    case 'no-article': return 'no-article';
    case 'filesystem': return 'fs';
    default: return '';
  }
}

/**
 * Start the web UI server and keep the process alive until the user hits Ctrl+C.
 * All URL-scoped options (out, localize-images, …) are forwarded as pipeline
 * options so the web UI honors the same flags as the CLI.
 */
async function runWebServer(
  opts: {
    out: string;
    overwrite?: boolean;
    verbose?: boolean;
    adapters?: boolean;
    localizeImages?: boolean;
    imageMaxBytes?: number;
    imageConcurrency?: number;
    timeout?: number;
    retries?: number;
    host?: string;
    port?: number;
  },
  startWeb: (options: WebServerOptions) => Promise<{ port: number; close: () => Promise<void> }>
): Promise<void> {
  const imageOptions: Record<string, number> = {};
  if (typeof opts.imageMaxBytes === 'number') imageOptions.maxBytes = opts.imageMaxBytes;
  if (typeof opts.imageConcurrency === 'number') imageOptions.concurrency = opts.imageConcurrency;

  const baseOptions: Omit<PipelineOptions, 'outDir'> = {
    overwrite: !!opts.overwrite,
    verbose: !!opts.verbose,
    disableAdapters: !opts.adapters,
    localizeImages: !!opts.localizeImages,
    imageOptions,
    fetch: {
      timeoutMs: opts.timeout,
      retries: opts.retries
    }
  };

  const handle = await startWeb({
    host: opts.host,
    port: opts.port,
    outDir: opts.out,
    pipelineOptions: baseOptions
  });

  console.log(`[webcopy:web] listening on http://${opts.host}:${handle.port}`);
  console.log(`[webcopy:web] output dir: ${opts.out}`);

  // Keep the process alive; Ctrl+C closes the server.
  const shutdown = async () => {
    console.log('\n[webcopy:web] shutting down…');
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildCli();
  program.parse(argv);
}
