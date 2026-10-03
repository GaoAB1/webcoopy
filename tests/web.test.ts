import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type WebServer } from '../src/web.js';

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Web UI Test Post</title></head>
<body>
<article>
  <h1>Web UI Test Post</h1>
  <p>This post is about <strong>web testing</strong>.</p>
  <h2>Section</h2>
  <p>Some content with a <a href="https://example.com">link</a>.</p>
</article>
</body>
</html>`;

let dir: string;
let server: WebServer;
let fetchFn: ReturnType<typeof vi.fn>;
// Save the real fetch BEFORE any mock replaces globalThis.fetch.
// The mock is only for the server's internal fetch calls (inside processUrl);
// the test itself must use realFetch to talk to the actual HTTP server.
const realFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'webcopy-web-'));
  fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  });
  globalThis.fetch = fetchFn as unknown as typeof fetch;

  server = await startServer({
    port: 0, // pick a random free port
    outDir: dir,
    pipelineOptions: { overwrite: true }
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

/** Call the running server via the real (un-mocked) fetch. */
function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  return realFetch(`${server.url}${path}`, init) as Promise<Response>;
}

describe('web server', () => {
  it('serves the HTML UI at GET /', async () => {
    const res = await serverFetch('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('WebCopy');
    expect(html).toContain('拖拽');
    expect(html).toContain('<script>');
  });

  it('returns health info at GET /api/health', async () => {
    const res = await serverFetch('/api/health');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.version).toBeTypeOf('string');
    expect(data.outDir).toBe(dir);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await serverFetch('/nope');
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('not found');
  });

  it('POST /api/convert with valid URL writes markdown and returns slug', async () => {
    const res = await serverFetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/my-post' })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.slug).toBeTypeOf('string');
    expect(data.slug).toContain('my-post');
    expect(data.title).toBe('Web UI Test Post');
    expect(data.downloadUrl).toBe(`/api/download/${encodeURIComponent(data.slug)}`);
    expect(data.path).toContain(`${data.slug}.md`);

    // File should exist on disk.
    const content = await readFile(join(dir, `${data.slug}.md`), 'utf-8');
    expect(content).toContain('title: "Web UI Test Post"');
    expect(content).toContain('web testing');
  });

  it('POST /api/convert without url returns 400', async () => {
    const res = await serverFetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('url');
  });

  it('POST /api/convert with invalid JSON returns 400', async () => {
    const res = await serverFetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json'
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('JSON');
  });

  it('GET /api/list returns empty list when outDir is empty', async () => {
    const res = await serverFetch('/api/list');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.count).toBe(0);
    expect(data.files).toEqual([]);
  });

  it('GET /api/list returns markdown files after conversion', async () => {
    // Convert first.
    await serverFetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/list-test' })
    });
    const res = await serverFetch('/api/list');
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.files.some((f: string) => f.includes('list-test'))).toBe(true);
  });

  it('GET /api/download/<slug> serves the markdown file', async () => {
    // Convert first.
    const conv = await (await serverFetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/download-test' })
    })).json();
    expect(conv.ok).toBe(true);

    const res = await serverFetch(conv.downloadUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const text = await res.text();
    expect(text).toContain('Web UI Test Post');
  });

  it('GET /api/download/<slug> returns 404 for missing slug', async () => {
    const res = await serverFetch('/api/download/does-not-exist');
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('GET /api/download/<slug> rejects path-traversal slugs', async () => {
    // Try to escape outDir via ../
    const res = await serverFetch('/api/download/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('invalid slug');
  });

  it('POST /api/convert with oversized body returns 413', async () => {
    const bigBody = 'x'.repeat(200 * 1024);
    const res = await serverFetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{ "url": "${bigBody}" }`
    });
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('too large');
  });

  it('handles fetch failure gracefully (returns 502 with error)', async () => {
    fetchFn.mockImplementation(async () => {
      throw new Error('network down');
    });
    const res = await serverFetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/fail' })
    });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('network down');
  });

  it('sends CORS headers for cross-origin requests', async () => {
    const res = await serverFetch('/api/health', {
      headers: { Origin: 'http://localhost:5173' }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('binds to a random port when port=0', async () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toContain(`:${server.port}`);
  });
});
