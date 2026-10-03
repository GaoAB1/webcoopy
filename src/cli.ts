import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { processMany, type PipelineOptions } from './pipeline.js';
import { startServer, type WebServerOptions } from './web.js';

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
    .version('0.1.0')
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
    .action(async (urls: string[], opts) => {
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
