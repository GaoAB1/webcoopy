import { Command } from 'commander';
import { readFile, rm } from 'node:fs/promises';
import { processMany, processUrl, defaultAdapters, type PipelineOptions } from './pipeline.js';
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
    .action(async (urls: string[], opts) => {
      if (opts.doctor) {
        printDoctor();
        // With URLs supplied, also probe the live fetch path so a single
        // command can distinguish "stale build" from "site changed".
        if (urls.length > 0) {
          await probeUrls(urls, opts);
        }
        return;
      }
      if (opts.web) {
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
 * writing anything to disk. Used by `--doctor <url>` to tell "the build is
 * stale" apart from "the site changed its markup".
 */
async function probeUrls(
  urls: string[],
  opts: { timeout?: number; retries?: number }
): Promise<void> {
  const registry = defaultAdapters();
  console.log('');
  console.log('live probe:');

  for (const url of urls) {
    const matched = registry.findFor(url);
    const adapter = matched[0]?.name ?? '(none — Readability fallback)';
    console.log(`  ${url}`);
    console.log(`    adapter: ${adapter}`);

    try {
      const result = await processUrl(url, {
        outDir: './.webcopy-probe',
        overwrite: true,
        verbose: false,
        fetch: { timeoutMs: opts.timeout, retries: opts.retries }
      });

      if (!result.ok) {
        console.log(`    RESULT: FAILED [${result.errorCode ?? 'unknown'}] ${result.error ?? ''}\n`);
        continue;
      }

      const body = result.path ? await readFile(result.path, 'utf-8').catch(() => '') : '';
      const placeholder = /^\s*(please\s*wait|loading)\s*\.{0,3}\s*$/im.test(body);
      console.log(`    title:  ${result.title ?? '(none)'}`);
      console.log(`    body:   ${body.length} chars${placeholder ? '  ← LOOKS LIKE A PLACEHOLDER PAGE' : ''}`);
      console.log(`    RESULT: ${placeholder ? 'SUSPECT' : 'ok'}\n`);

      // Probe output is throwaway — do not leave it behind.
      if (result.path) await rm(result.path, { force: true }).catch(() => {});
    } catch (err) {
      console.log(`    RESULT: error ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  await rm('./.webcopy-probe', { recursive: true, force: true }).catch(() => {});
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
