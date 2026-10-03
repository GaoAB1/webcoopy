import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Image localizer for webcopy.
 *
 * Extracts remote image URLs from a markdown string, downloads them under
 * `<outDir>/<slug>/images/<sha1>.<ext>`, and rewrites the image links to
 * relative paths (`images/<sha1>.<ext>`). Failed downloads leave the original
 * URL untouched so the article still renders.
 *
 * Design notes:
 * - Dedup by SHA1 of body bytes — the same image referenced multiple times
 *   (or across articles) is written once.
 * - Extension inferred from `Content-Type`, then from the URL path, then `.bin`.
 * - Only `http(s)://` URLs are downloaded. `data:`, relative, and
 *   protocol-relative URLs are left untouched.
 * - Per-image retry and timeout reuse the same policy as `fetcher.ts` so
 *   tests can inject a single stub.
 */

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image
export const DEFAULT_IMAGE_TIMEOUT_MS = 15_000;
export const DEFAULT_IMAGE_RETRIES = 2;
export const DEFAULT_IMAGE_CONCURRENCY = 4;

export interface ImageDownload {
  /** Raw bytes of the image. */
  data: Uint8Array;
  /** Response `Content-Type` header (may be empty). */
  contentType: string;
}

export type ImageFetcher = (url: string) => Promise<ImageDownload>;

export interface ImageLocalizerOptions {
  /** Root output directory. Images are placed under `<outDir>/<slug>/images/`. */
  outDir: string;
  /** Article slug; used as the sub-folder name for the images directory. */
  slug: string;
  /** Max bytes per image. Images larger than this are skipped (not downloaded). Default 10 MB. */
  maxBytes?: number;
  /** Request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Total attempts per image (including the first). Default 2. */
  retries?: number;
  /** Max images to download in parallel. Default 4. Set 1 for serial. */
  concurrency?: number;
  /** Injectable fetcher. Used by tests. */
  fetcher?: ImageFetcher;
}

export interface LocalizeResult {
  markdown: string;
  /** Number of images successfully downloaded and rewritten. */
  local: number;
  /** Number of images that failed to download; original URL preserved. */
  failed: number;
  /** Number of images skipped (data:/relative/empty/oversized). */
  skipped: number;
}

/**
 * Markdown image matcher.
 *
 * Shape: `![alt](url "title"?)`
 * - alt can contain anything but unescaped `]` (good enough for scraped pages).
 * - url is `\S+` — no whitespace, so we don't accidentally swallow the trailing
 *   quote of an inline title.
 * - title is optional and quoted.
 */
const MD_IMAGE_RE = /(!\[[^\]]*\])\((\S+)(\s+"[^"]*")?\)/g;

/**
 * Return every unique `http(s)://` image URL referenced in the markdown,
 * in first-seen order. Non-remote URLs (`data:`, `//`, relative) are filtered out.
 */
export function extractImageUrls(markdown: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  MD_IMAGE_RE.lastIndex = 0;
  while ((m = MD_IMAGE_RE.exec(markdown)) !== null) {
    const url = m[2];
    if (!isRemoteImageUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function isRemoteImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Infer the file extension from a Content-Type header, falling back to the
 * URL's path extension, and finally `.bin`.
 */
export function extForUrl(url: string, contentType: string): string {
  const type = (contentType.split(';')[0] ?? '').toLowerCase().trim();
  const byType: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/x-xbitmap': 'xbm'
  };
  if (byType[type]) return byType[type];

  // Fall back to URL path extension.
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-zA-Z0-9]{1,5})$/);
    if (m) return m[1].toLowerCase();
  } catch {
    // Ignore malformed URLs.
  }
  return 'bin';
}

function sha1Hex(buf: Uint8Array): string {
  return createHash('sha1').update(Buffer.from(buf)).digest('hex');
}

/**
 * Download every remote image referenced in `markdown` and rewrite the URLs
 * to relative local paths. Non-remote URLs are left alone. Failed downloads
 * keep the original URL so the article degrades gracefully.
 */
export async function localizeImages(
  markdown: string,
  options: ImageLocalizerOptions
): Promise<LocalizeResult> {
  const urls = extractImageUrls(markdown);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_IMAGE_RETRIES;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_IMAGE_CONCURRENCY);
  const fetcher = options.fetcher ?? defaultImageFetcher(timeoutMs, retries);

  if (urls.length === 0) {
    return { markdown, local: 0, failed: 0, skipped: 0 };
  }

  const imagesDir = join(options.outDir, options.slug, 'images');
  await mkdir(imagesDir, { recursive: true });

  const rewrites = new Map<string, string>();
  const seenHashes = new Set<string>();
  let local = 0;
  let failed = 0;
  let skipped = 0;

  // Process images with a bounded worker pool. Each worker pulls URLs from a
  // shared queue. Failures are contained per-image so one bad URL never blocks
  // the others. A `seenHashes` cache prevents concurrent writes to the same
  // SHA1-named file when different URLs happen to share bytes.
  const processImage = async (url: string): Promise<void> => {
    try {
      const { data, contentType } = await fetcher(url);
      if (data.byteLength === 0) {
        skipped++;
        return;
      }
      if (data.byteLength > maxBytes) {
        skipped++;
        return;
      }
      const hash = sha1Hex(data);
      const ext = extForUrl(url, contentType);
      const relPath = `images/${hash}.${ext}`;
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        const absPath = join(options.outDir, options.slug, relPath);
        await writeFile(absPath, Buffer.from(data));
      }
      rewrites.set(url, relPath);
      local++;
    } catch {
      // Keep the original URL; count as a failure so callers can report it.
      failed++;
    }
  };

  // Worker pool: `workerCount` workers pull URLs from a shared queue.
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, urls.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(
      (async () => {
        for (;;) {
          const idx = nextIndex++;
          if (idx >= urls.length) return;
          await processImage(urls[idx]!);
        }
      })()
    );
  }
  await Promise.all(workers);

  if (rewrites.size === 0) {
    return { markdown, local, failed, skipped };
  }

  const result = markdown.replace(MD_IMAGE_RE, (_whole, altPart, url, titlePart) => {
    const relPath = rewrites.get(url);
    if (!relPath) return _whole;
    return `${altPart}(${relPath}${titlePart ?? ''})`;
  });

  return { markdown: result, local, failed, skipped };
}

/**
 * Default image fetcher: fetch the URL, apply a content-length / body-size
 * cap, retry on transient failures (network, timeout, 5xx, 429), and return
 * the raw bytes with the response Content-Type.
 */
export function defaultImageFetcher(
  timeoutMs: number,
  retries: number
): ImageFetcher {
  return async (url) => {
    const attempts = Math.max(1, retries);
    let lastErr: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; webcopy/0.2; +https://github.com/GaoAB1/webcopy)',
            'Accept': 'image/*,*/*;q=0.8'
          }
        });
        if (!res.ok) {
          const status = res.status;
          const retryable = status === 429 || status >= 500;
          const err = new Error(`HTTP ${status} for ${url}`);
          (err as { retryable?: boolean }).retryable = retryable;
          throw err;
        }
        const lenHeader = Number(res.headers.get('content-length') ?? '');
        if (Number.isFinite(lenHeader) && lenHeader > DEFAULT_MAX_IMAGE_BYTES) {
          const err = new Error(`Image too large (${lenHeader}B): ${url}`);
          (err as { retryable?: boolean }).retryable = false;
          throw err;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') ?? '';
        return { data: buf, contentType };
      } catch (err) {
        lastErr = err;
        const retryable = isRetryableImageError(err);
        const isLast = attempt === attempts - 1;
        if (isLast || !retryable) break;
        await sleep(250 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
}

function isRetryableImageError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') return true;
  if (err instanceof TypeError) return true; // Node's fetch network errors
  const flag = (err as { retryable?: boolean } | null)?.retryable;
  if (typeof flag === 'boolean') return flag;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
