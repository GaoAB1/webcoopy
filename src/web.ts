import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, access, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { processUrl, type PipelineOptions } from './pipeline.js';

export const WEB_VERSION = '0.1.0';

export interface WebServerOptions {
  /** Host to bind. Default: 127.0.0.1 */
  host?: string;
  /** Port to listen on. Default: 3000 */
  port?: number;
  /** Output directory for downloaded articles. Default: ./output */
  outDir?: string;
  /** Base options forwarded to processUrl (overwrite, fetch, localizeImages, …). */
  pipelineOptions?: Partial<Omit<PipelineOptions, 'outDir'>>;
  /** Log function. Default: console.log. */
  log?: (msg: string) => void;
}

export interface WebServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_OUT_DIR = './output';
const MAX_BODY_BYTES = 64 * 1024; // 64 KB — enough for JSON payloads

/**
 * Start the web server and return a handle. Resolves once the port is bound.
 */
export async function startServer(options: WebServerOptions = {}): Promise<WebServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const log = options.log ?? ((msg: string) => console.log(`[webcopy:web] ${msg}`));
  const baseOptions = options.pipelineOptions ?? {};

  const server = createServer((req, res) => {
    void handleRequest(req, res, { outDir, baseOptions, log }).catch((err) => {
      log(`unhandled error: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { ok: false, error: 'internal error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const bound = (server.address() as { port: number } | null)?.port ?? port;
  return {
    server,
    port: bound,
    url: `http://${host}:${bound}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    })
  };
}

interface Ctx {
  outDir: string;
  baseOptions: Partial<Omit<PipelineOptions, 'outDir'>>;
  log: (msg: string) => void;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';

  // CORS for local dev (browsers may block file:// or other origins).
  setCors(res, req);

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Allow': 'GET, POST, OPTIONS' });
    res.end();
    return;
  }

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return sendHtml(res, INDEX_HTML);
  }
  if (method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      version: WEB_VERSION,
      outDir: ctx.outDir
    });
  }
  if (method === 'POST' && url.pathname === '/api/convert') {
    return handleConvert(req, res, ctx);
  }
  if (method === 'GET' && url.pathname === '/api/list') {
    return handleList(res, ctx);
  }
  if (method === 'GET' && url.pathname.startsWith('/api/download/')) {
    const slug = decodeURIComponent(url.pathname.slice('/api/download/'.length));
    return handleDownload(res, ctx, slug);
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

async function handleConvert(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    return sendJson(res, 413, { ok: false, error: body.error });
  }
  let payload: { url?: string; options?: Partial<PipelineOptions> };
  try {
    payload = JSON.parse(body.text);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
  }
  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  if (!url) {
    return sendJson(res, 400, { ok: false, error: 'url is required' });
  }

  const options: PipelineOptions = {
    outDir: ctx.outDir,
    overwrite: ctx.baseOptions.overwrite ?? false,
    ...ctx.baseOptions,
    ...payload.options,
    verbose: true
  };

  const t0 = Date.now();
  const result = await processUrl(url, options);
  const elapsed = Date.now() - t0;
  ctx.log(`convert ${url} → ${result.ok ? 'ok' : 'failed'} (${elapsed}ms)`);

  if (result.ok) {
    return sendJson(res, 200, {
      ok: true,
      slug: result.slug,
      title: result.title,
      path: result.path,
      skipped: result.skipped ?? false,
      downloadUrl: `/api/download/${encodeURIComponent(result.slug)}`,
      elapsed
    });
  }
  return sendJson(res, 502, {
    ok: false,
    url,
    error: result.error,
    errorCode: result.errorCode,
    elapsed
  });
}

async function handleList(res: ServerResponse, ctx: Ctx): Promise<void> {
  let entries: string[] = [];
  try {
    const files = await readdir(ctx.outDir);
    entries = files.filter((f) => f.endsWith('.md')).sort();
  } catch {
    // outDir may not exist yet — that's fine, return empty list.
  }
  return sendJson(res, 200, { ok: true, count: entries.length, files: entries });
}

async function handleDownload(res: ServerResponse, ctx: Ctx, slug: string): Promise<void> {
  // Slugs come from slugify() so they're already filesystem-safe, but we
  // still resolve and verify the file stays inside outDir to be defensive.
  const safe = sanitizeSlug(slug);
  if (!safe) {
    return sendJson(res, 400, { ok: false, error: 'invalid slug' });
  }
  const target = resolve(ctx.outDir, `${safe}.md`);
  const outRoot = resolve(ctx.outDir);
  if (!target.startsWith(outRoot)) {
    return sendJson(res, 400, { ok: false, error: 'invalid slug' });
  }
  try {
    await access(target);
  } catch {
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }
  const content = await readFile(target, 'utf-8');
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safe}.md"`,
    'Content-Length': Buffer.byteLength(content, 'utf-8')
  });
  res.end(content);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sanitizeSlug(slug: string): string | undefined {
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    return undefined;
  }
  // Allow alphanumerics, dashes, underscores, CJK — same charset slugify() emits.
  if (!/^[a-z0-9\u4e00-\u9fff_\-]+$/.test(slug)) return undefined;
  return slug;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let size = 0;
    let resolved = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (resolved) return;
      size += chunk.length;
      if (size > maxBytes) {
        resolved = true;
        resolve({ ok: false, error: `body too large (max ${maxBytes} bytes)` });
        // Pause so the caller can send a 413 response before the stream ends.
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf-8') });
    });
    req.on('error', () => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, error: 'request stream error' });
    });
  });
}

function setCors(res: ServerResponse, req: IncomingMessage): void {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin && isSafeOrigin(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isSafeOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text, 'utf-8')
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html, 'utf-8')
  });
  res.end(html);
}

// ── embedded single-file UI ──────────────────────────────────────────────────

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebCopy — 拖拽下载网页为 Markdown</title>
<style>
  :root {
    --bg: #0b0d12;
    --panel: #141821;
    --panel-2: #1b2030;
    --border: #2a3142;
    --text: #e6e9f2;
    --muted: #8b93a7;
    --accent: #6ea8ff;
    --accent-2: #4b7fdc;
    --ok: #4ade80;
    --err: #f87171;
    --warn: #fbbf24;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: radial-gradient(1200px 600px at 20% 0%, #1a2238 0%, var(--bg) 60%);
    color: var(--text);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px 20px;
    min-height: 100vh;
  }
  header { text-align: center; margin-bottom: 28px; }
  h1 {
    margin: 0 0 6px;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
    background: linear-gradient(135deg, #fff 0%, var(--accent) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  header p { margin: 0; color: var(--muted); font-size: 14px; }
  .dropzone {
    width: 100%;
    max-width: 680px;
    min-height: 220px;
    background: var(--panel);
    border: 2px dashed var(--border);
    border-radius: 18px;
    padding: 32px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    transition: border-color .18s, background .18s, transform .12s;
    cursor: pointer;
    text-align: center;
  }
  .dropzone:hover { border-color: var(--accent-2); background: var(--panel-2); }
  .dropzone.dragging {
    border-color: var(--accent);
    background: linear-gradient(135deg, rgba(110,168,255,.12), rgba(75,127,220,.08));
    transform: scale(1.01);
  }
  .dropzone .icon {
    width: 56px; height: 56px;
    border-radius: 16px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 8px 24px rgba(75,127,220,.35);
  }
  .dropzone .icon svg { width: 28px; height: 28px; stroke: #fff; fill: none; stroke-width: 2; }
  .dropzone h2 { margin: 0; font-size: 18px; font-weight: 600; }
  .dropzone p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .dropzone .paste { margin-top: 6px; }
  .dropzone .paste button {
    margin-top: 10px;
    background: var(--accent-2);
    color: #fff;
    border: 0;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  textarea {
    width: 100%;
    min-height: 90px;
    background: #0f1219;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    font-family: "SF Mono", "Cascadia Code", Consolas, monospace;
    font-size: 12px;
    resize: vertical;
    display: none;
  }
  textarea.visible { display: block; }
  .status {
    margin-top: 22px;
    width: 100%;
    max-width: 680px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 14px;
    font-size: 13px;
  }
  .row .dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--muted);
    flex-shrink: 0;
  }
  .row.ok .dot { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .row.err .dot { background: var(--err); box-shadow: 0 0 8px var(--err); }
  .row.pending .dot { background: var(--warn); box-shadow: 0 0 8px var(--warn); animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: .4; } }
  .row .url { flex: 1; color: var(--text); word-break: break-all; }
  .row .meta { color: var(--muted); font-size: 12px; }
  .row .dl {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
    font-size: 12px;
    padding: 4px 10px;
    border: 1px solid var(--accent-2);
    border-radius: 6px;
  }
  .row .dl:hover { background: var(--accent-2); color: #fff; }
  .options {
    width: 100%;
    max-width: 680px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    margin-top: 20px;
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .options label {
    display: flex; align-items: center; gap: 6px;
    color: var(--muted); cursor: pointer;
  }
  .options input[type="checkbox"] { accent-color: var(--accent); }
  .options .spacer { flex: 1; }
  .options .clear {
    background: transparent; border: 1px solid var(--border); color: var(--muted);
    padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  }
  .options .clear:hover { color: var(--text); border-color: var(--accent-2); }
  footer {
    margin-top: 32px;
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
  <header>
    <h1>WebCopy</h1>
    <p>拖拽或粘贴 URL，一键保存为 Markdown</p>
  </header>

  <div class="dropzone" id="dropzone">
    <div class="icon">
      <svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <h2>把 URL 拖到这里</h2>
    <p>支持拖拽文本、链接、甚至整个浏览器标签页。<br>也可以点击粘贴。</p>
    <div class="paste">
      <button type="button" id="paste-btn">粘贴 URL…</button>
    </div>
    <textarea id="paste-area" placeholder="每行一个 URL，回车提交"></textarea>
  </div>

  <div class="options">
    <label><input type="checkbox" id="opt-localize"> 本地化图片</label>
    <label><input type="checkbox" id="opt-overwrite"> 覆盖已有文件</label>
    <div class="spacer"></div>
    <button class="clear" id="clear-btn" type="button">清空列表</button>
  </div>

  <div class="status" id="status"></div>

  <footer>
    <span id="health">连接中…</span> · <a href="https://github.com/GaoAB1/webcopy" target="_blank" rel="noopener">GitHub</a>
  </footer>

<script>
(function () {
  'use strict';
  const dropzone = document.getElementById('dropzone');
  const status = document.getElementById('status');
  const pasteBtn = document.getElementById('paste-btn');
  const pasteArea = document.getElementById('paste-area');
  const optLocalize = document.getElementById('opt-localize');
  const optOverwrite = document.getElementById('opt-overwrite');
  const clearBtn = document.getElementById('clear-btn');
  const health = document.getElementById('health');

  let queue = []; // [{id, url, state, title, downloadUrl, error}]

  function parseUrls(text) {
    if (!text) return [];
    return text
      .split(/\\n|\\s+/)
      .map(s => s.trim().replace(/^[\\[\\\"']|[\\]\"']$/g, ''))
      .filter(s => /^https?:\\/\\//i.test(s))
      .filter((v, i, a) => a.indexOf(v) === i);
  }

  function row(id, url, state, extra) {
    const el = document.createElement('div');
    el.className = 'row ' + state;
    el.dataset.id = id;
    const dot = document.createElement('span'); dot.className = 'dot';
    const urlEl = document.createElement('span'); urlEl.className = 'url';
    urlEl.textContent = url;
    const meta = document.createElement('span'); meta.className = 'meta';
    let dl = null;
    if (state === 'ok') {
      dl = document.createElement('a');
      dl.href = '/api/download/' + encodeURIComponent(extra.slug);
      dl.className = 'dl';
      dl.textContent = '↓ 下载 Markdown';
    }
    meta.textContent = state === 'pending' ? '处理中…' : (state === 'ok' ? (extra.title ? ('标题：' + extra.title) : '完成') : (extra.error || '失败'));
    el.appendChild(dot); el.appendChild(urlEl); el.appendChild(meta);
    if (dl) el.appendChild(dl);
    status.appendChild(el);
    return el;
  }

  function setState(id, state, extra) {
    const el = status.querySelector('[data-id="' + id + '"]');
    if (!el) return;
    el.className = 'row ' + state;
    if (state === 'ok') {
      const dl = document.createElement('a');
      dl.href = '/api/download/' + encodeURIComponent(extra.slug);
      dl.className = 'dl';
      dl.textContent = '↓ 下载 Markdown';
      const meta = el.querySelector('.meta');
      meta.textContent = extra.title ? ('标题：' + extra.title) : '完成';
      el.appendChild(dl);
    } else if (state === 'err') {
      const meta = el.querySelector('.meta');
      meta.textContent = extra.error || '失败';
    }
  }

  async function submit(urls) {
    if (!urls.length) return;
    const options = {
      localizeImages: optLocalize.checked,
      overwrite: optOverwrite.checked
    };
    for (const url of urls) {
      const id = 'r' + Math.random().toString(36).slice(2, 8);
      row(id, url, 'pending', {});
      try {
        const res = await fetch('/api/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, options })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          setState(id, 'ok', { slug: data.slug, title: data.title });
        } else {
          setState(id, 'err', { error: data.error || ('HTTP ' + res.status) });
        }
      } catch (e) {
        setState(id, 'err', { error: String(e) });
      }
    }
  }

  // Drag & drop
  ['dragenter', 'dragover'].forEach(ev =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add('dragging');
    }));
  ['dragleave', 'drop'].forEach(ev =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove('dragging');
    }));

  dropzone.addEventListener('drop', async (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    // Prefer text/uri-list (dropped links), then text/plain.
    const uriList = dt.getData('text/uri-list');
    const text = uriList || dt.getData('text/plain');
    // Also handle file drags: read text from file(s) if any.
    let fileText = '';
    const files = dt.files;
    if (files && files.length) {
      for (const f of files) {
        if (f.size < 65536) {
          fileText += (await f.text()) + '\\n';
        }
      }
    }
    const urls = parseUrls(text + '\\n' + fileText);
    if (urls.length) submit(urls);
  });

  // Click to paste
  pasteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pasteArea.classList.add('visible');
    pasteArea.focus();
  });
  pasteArea.addEventListener('blur', () => pasteArea.classList.remove('visible'));
  pasteArea.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const urls = parseUrls(pasteArea.value);
      pasteArea.value = '';
      if (urls.length) submit(urls);
    }
    if (e.key === 'Escape') pasteArea.classList.remove('visible');
  });

  // Click anywhere in dropzone (not on the paste button) → try clipboard read.
  dropzone.addEventListener('click', async (e) => {
    if (e.target === pasteBtn || e.target === pasteArea) return;
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        const urls = parseUrls(text);
        if (urls.length) submit(urls);
      }
    } catch (_) { /* clipboard may be denied */ }
  });

  clearBtn.addEventListener('click', () => { status.innerHTML = ''; queue = []; });

  // Health check
  fetch('/api/health').then(r => r.json()).then(d => {
    health.textContent = d.ok ? ('已连接 · ' + d.version) : '连接失败';
  }).catch(() => { health.textContent = '连接失败'; });
})();
</script>
</body>
</html>
`;
