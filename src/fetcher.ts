import { Buffer } from 'node:buffer';
import * as iconv from 'iconv-lite';

export type FetchErrorCode =
  | 'timeout'
  | 'network'
  | 'http'
  | 'redirect-loop'
  | 'unsupported-type'
  | 'charset-error';

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly code: FetchErrorCode,
    public readonly status?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetchResult {
  /** HTML content, decoded to UTF-8 string. */
  html: string;
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  /** Effective charset detected/used for decoding. */
  charset: string;
}

export interface FetcherOptions {
  /** Request timeout in ms. Default: 15000 */
  timeoutMs?: number;
  /** Total attempts (default: 3). Retried on network/timeout/5xx/429. */
  retries?: number;
  /** Base delay between retries in ms (exponential backoff: base * 2^attempt). Default: 500 */
  retryDelayMs?: number;
  /** Override User-Agent header. */
  userAgent?: string;
  /** Extra headers to merge into the request. */
  headers?: Record<string, string>;
  /** Maximum content length in bytes; default: 10MB. Larger responses are truncated. */
  maxBytes?: number;
}

const DEFAULT_UA =
  'Mozilla/5.0 (compatible; webcopy/0.2; +https://github.com/GaoAB1/webcopy)';
const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 500;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Fetch a URL, retry on transient failures, detect charset, and return HTML as a UTF-8 string.
 */
export async function fetchHtml(
  url: string,
  options: FetcherOptions = {}
): Promise<FetchResult> {
  const attempts = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY;

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await fetchOnce(url, {
        timeoutMs: options.timeoutMs,
        userAgent: options.userAgent,
        headers: options.headers,
        maxBytes: options.maxBytes
      });
      return result;
    } catch (err) {
      lastErr = err;
      if (err instanceof FetchError && !isRetryable(err)) throw err;

      const isLast = attempt === attempts - 1;
      if (isLast) break;

      await sleep(baseDelay * 2 ** attempt);
    }
  }

  throw lastErr instanceof Error ? lastErr : new FetchError(String(lastErr), 'network');
}

function isRetryable(err: FetchError): boolean {
  if (err.code === 'timeout' || err.code === 'network' || err.code === 'redirect-loop') {
    return true;
  }
  if (err.code === 'http' && err.status !== undefined) {
    // Retry 429 and 5xx; skip 4xx (auth, not found, anti-bot).
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FetchOnceOptions {
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  maxBytes?: number;
}

async function fetchOnce(url: string, opts: FetchOnceOptions): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8,zh-CN;q=0.7,zh;q=0.6',
        ...(opts.headers ?? {})
      }
    });

    const finalUrl = res.url || url;
    const contentType = res.headers.get('content-type') ?? '';

    if (!res.ok) {
      const hint = httpHint(res.status);
      throw new FetchError(
        `HTTP ${res.status} ${res.statusText} for ${finalUrl}${hint ? ` (${hint})` : ''}`,
        'http',
        res.status
      );
    }

    // Constrain body size to avoid huge responses.
    const lenHeader = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(lenHeader) && lenHeader > maxBytes) {
      throw new FetchError(
        `Response too large (${lenHeader}B > ${maxBytes}B): ${finalUrl}`,
        'unsupported-type'
      );
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new FetchError(
        `Response too large (${buf.byteLength}B > ${maxBytes}B): ${finalUrl}`,
        'unsupported-type'
      );
    }

    const html = decodeHtml(buf, contentType);
    return { html, url: finalUrl, contentType, status: res.status, charset: htmlCharset };
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new FetchError(
        `Request timed out after ${timeoutMs}ms: ${url}`,
        'timeout',
        undefined,
        err
      );
    }
    // Some environments (and tests) surface abort as a plain Error with name === 'AbortError'.
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
      throw new FetchError(
        `Request timed out after ${timeoutMs}ms: ${url}`,
        'timeout',
        undefined,
        err
      );
    }
    if (err instanceof TypeError) {
      // Node's fetch throws TypeError on network errors.
      throw new FetchError(
        `Network error fetching ${url}: ${err.message}`,
        'network',
        undefined,
        err
      );
    }
    throw new FetchError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`, 'network', undefined, err);
  } finally {
    clearTimeout(timer);
  }
}

function httpHint(status: number): string {
  if (status === 401 || status === 403) return 'auth required or blocked';
  if (status === 404) return 'page not found';
  if (status === 429) return 'rate-limited';
  if (status === 451) return 'blocked by policy';
  if (status === 402) return 'paywall';
  if (status >= 500) return 'server error';
  return '';
}

/** Charset chosen by the decoder, kept as module state for FetchResult return. */
let htmlCharset = 'utf-8';

/**
 * Decode an HTML byte buffer to a UTF-8 string, respecting declared charset.
 * Supports UTF-8, ISO-8859-1, UTF-16, and (via iconv-lite) GBK/GB2312/Shift-JIS/Windows-1252 etc.
 */
export function decodeHtml(buf: Buffer, contentTypeHeader: string): string {
  const declared = detectCharset(buf, contentTypeHeader);
  htmlCharset = declared;
  return decodeWithCharset(buf, declared);
}

/**
 * Detect the declared charset from (in priority order):
 * 1. HTTP Content-Type header (`; charset=xxx`)
 * 2. `<meta charset="xxx">` (case-insensitive)
 * 3. `<meta http-equiv="Content-Type" content="...; charset=xxx">`
 * Falls back to 'utf-8'.
 */
export function detectCharset(buf: Buffer, contentTypeHeader: string): string {
  // 1. HTTP header
  const fromHeader = parseHeaderCharset(contentTypeHeader);
  if (fromHeader) return fromHeader;

  // 2. Peek first 1KB as latin-1 to find meta tags without corrupting bytes.
  const peek = buf.subarray(0, 1024).toString('latin1');
  const metaCharset = peek.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (metaCharset) return metaCharset[1];
  const httpEquiv = peek.match(/<meta[^>]+http-equiv=["']content-type["'][^>]*content=["'][^"']*charset=["']?([\w-]+)/i);
  if (httpEquiv) return httpEquiv[1];

  return 'utf-8';
}

function parseHeaderCharset(header: string): string | undefined {
  const m = header.match(/charset=["']?([\w-]+)/i);
  return m?.[1];
}

function decodeWithCharset(buf: Buffer, charset: string): string {
  const normalized = charset.toLowerCase().trim();
  // Node Buffer natively supports these encodings.
  const native: Record<string, BufferEncoding> = {
    'utf-8': 'utf8',
    'utf8': 'utf8',
    'utf-16': 'utf16le',
    'utf-16le': 'utf16le',
    'latin1': 'latin1',
    'iso-8859-1': 'latin1',
    'iso-8859-15': 'latin1',
    'ascii': 'ascii'
  };
  if (native[normalized]) return buf.toString(native[normalized]);

  // Use iconv-lite for GBK / Shift-JIS / etc.
  try {
    const encodings = iconv.encodingExists(normalized);
    if (!encodings) {
      // Try canonical aliases.
      const aliases: Record<string, string> = {
        'gb_2312': 'gb2312',
        'cp936': 'gbk',
        'csiso58gb231280': 'gb2312',
        'csiso2022jp': 'shift_jis',
        'csmswindows': 'windows-1251'
      };
      const canonical = aliases[normalized];
      if (canonical && iconv.encodingExists(canonical)) {
        return iconv.decode(buf, canonical);
      }
      // Unknown → warn but fall back to UTF-8.
      htmlCharset = 'utf-8 (fallback, declared as ' + charset + ')';
      return buf.toString('utf8');
    }
    return iconv.decode(buf, normalized);
  } catch {
    htmlCharset = 'utf-8 (decode-fallback)';
    return buf.toString('utf8');
  }
}
