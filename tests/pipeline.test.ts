import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { processUrl } from '../src/pipeline.js';

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Pipeline Test Post</title></head>
<body>
<article>
  <h1>Pipeline Test Post</h1>
  <p>This post is about <strong>testing</strong>.</p>
  <p>See <a href="#next">next</a> for details.</p>
  <h2 id="next">Next Steps</h2>
  <p>Here is a JS example:</p>
  <pre><code class="language-js">console.log('hi');</code></pre>
  <p>And a link to <a href="https://example.com/docs">docs</a>.</p>
</article>
</body>
</html>`;

let dir: string;
const origFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'webcopy-pipe-'));
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void init;
    return new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  await rm(dir, { recursive: true, force: true });
});

describe('processUrl (mocked fetch)', () => {
  it('returns ok and writes a markdown file with front-matter', async () => {
    const r = await processUrl('https://example.com/my-post', {
      outDir: dir,
      overwrite: false
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.path).toBe(join(dir, 'my-post.md'));
    expect(r.title).toBe('Pipeline Test Post');

    const content = await readFile(r.path!, 'utf-8');
    expect(content).toContain('title: "Pipeline Test Post"');
    expect(content).toContain('source: "https://example.com/my-post"');
    expect(content).toContain('---');
    expect(content).toContain('testing');
    expect(content).toContain('[next](#next)');
    expect(content).toContain('```js');
    expect(content).toContain('console.log');
    expect(content).toContain('[docs](https://example.com/docs)');
  });

  it('returns ok with skipped=true when the target already exists', async () => {
    await processUrl('https://example.com/my-post', {
      outDir: dir,
      overwrite: false
    });
    const r2 = await processUrl('https://example.com/my-post', {
      outDir: dir,
      overwrite: false
    });
    expect(r2.ok).toBe(true);
    expect(r2.skipped).toBe(true);
  });

  it('overwrites when overwrite=true', async () => {
    await processUrl('https://example.com/my-post', {
      outDir: dir,
      overwrite: false
    });
    const r2 = await processUrl('https://example.com/my-post', {
      outDir: dir,
      overwrite: true
    });
    expect(r2.ok).toBe(true);
    expect(r2.skipped).toBe(false);
  });

  it('returns ok=false with a descriptive error on HTTP failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await processUrl('https://down.test/x', { outDir: dir, overwrite: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('returns ok=false when the page is empty', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('<html><body></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
    ) as unknown as typeof fetch;
    const r = await processUrl('https://example.com/', { outDir: dir, overwrite: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/article/i);
    expect(r.errorCode).toBe('no-article');
  });

  it('returns ok=false with errorCode=timeout when the request times out', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((_, rej) => {
        const t = setTimeout(() => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), 10);
        init?.signal?.addEventListener('abort', () => clearTimeout(t));
      });
    }) as unknown as typeof fetch;
    const r = await processUrl('https://slow.test/', {
      outDir: dir,
      overwrite: false,
      fetch: { timeoutMs: 50, retries: 1 }
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('timeout');
  });

  it('retries transient 429 responses and eventually succeeds', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response('rate limited', { status: 429 });
      return new Response(SAMPLE_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });
    }) as unknown as typeof fetch;
    const r = await processUrl('https://example.com/my-post', {
      outDir: dir,
      overwrite: false,
      fetch: { retries: 2, retryDelayMs: 1 }
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not retry permanent 404 responses', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }) as unknown as typeof fetch;
    const r = await processUrl('https://example.com/missing', {
      outDir: dir,
      overwrite: false,
      fetch: { retries: 3, retryDelayMs: 1 }
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('http');
    expect(r.error).toContain('404');
    expect(calls).toBe(1);
  });

  it('uses the github adapter for github blob URLs and bypasses Readability', async () => {
    const rawMd = '# My README\n\nRaw markdown content from GitHub.';
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      expect(u).toContain('raw.githubusercontent.com');
      return new Response(rawMd, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }) as unknown as typeof fetch;

    const r = await processUrl('https://github.com/owner/repo/blob/main/README.md', {
      outDir: dir,
      overwrite: false
    });
    expect(r.ok).toBe(true);
    expect(r.adapter).toBe('github-readme');
    expect(r.title).toBeUndefined(); // github adapter doesn't set a title
    const content = await readFile(r.path!, 'utf-8');
    expect(content).toContain('# My README');
    expect(content).toContain('Raw markdown content from GitHub.');
    // Should NOT have been double-converted by turndown.
    expect(content).not.toContain('<h1>');
    // Front-matter source should point back to the original URL.
    expect(content).toContain('https://github.com/owner/repo/blob/main/README.md');
  });

  it('ignores adapters when disableAdapters is true', async () => {
    globalThis.fetch = vi.fn(async () => new Response(SAMPLE_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const r = await processUrl('https://github.com/owner/repo/blob/main/README.md', {
      outDir: dir,
      overwrite: false,
      disableAdapters: true
    });
    // GitHub adapter is disabled — the returned HTML (SAMPLE_HTML) is treated as an article.
    expect(r.ok).toBe(true);
    expect(r.adapter).toBeUndefined();
    expect(r.title).toBe('Pipeline Test Post');
  });

  it('uses the wechat adapter for mp.weixin.qq.com URLs', async () => {
    const html = `
<html>
<head><title>微信公众号文章 - 微信</title></head>
<body>
<h1 id="activity-name">微信标题</h1>
<div id="js_author_name">微信作者</div>
<div id="js_content">
  <p>这是正文第一段。</p>
  <p>这是正文第二段。</p>
  <img data-src="https://mmbiz.qpic.cn/xxx.jpg" src="data:image/svg+xml;base64,AAA">
  <pre><code class="language-js">console.log('wechat');</code></pre>
  <p>更多正文内容，用来确保适配器能识别出足够的正文长度阈值。</p>
  <p>更多段落内容填充，让适配器能稳定识别出正文。</p>
  <p>最后一段正文内容，包含一些额外的字符。</p>
</div>
<div class="js_pc_qr_code">二维码</div>
</body>
</html>`;
    globalThis.fetch = vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const r = await processUrl('https://mp.weixin.qq.com/s/abc123', { outDir: dir, overwrite: false });
    expect(r.ok).toBe(true);
    expect(r.adapter).toBe('wechat');
    expect(r.title).toBe('微信标题');
    const content = await readFile(r.path!, 'utf-8');
    expect(content).toContain('source: "https://mp.weixin.qq.com/s/abc123"');
    expect(content).not.toContain('<h1>');
    expect(content).not.toContain('二维码');
  });

  it('localizes remote images when localizeImages is enabled', async () => {
    const htmlWithImage = `<!DOCTYPE html>
<html>
<head><title>Post With Image</title></head>
<body>
<article>
  <h1>Post With Image</h1>
  <p>This post has an image.</p>
  <img src="https://cdn.example/photo.png" alt="photo">
  <p>Some trailing text to satisfy Readability's length check.</p>
  <p>More paragraphs so the article is detected as readable content, not a stub page.</p>
</article>
</body>
</html>`;
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let imageFetches = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.startsWith('https://cdn.example/')) {
        imageFetches++;
        return new Response(new Uint8Array(pngBytes), {
          status: 200,
          headers: { 'Content-Type': 'image/png' }
        });
      }
      return new Response(htmlWithImage, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;

    const r = await processUrl('https://example.com/post-with-image', {
      outDir: dir,
      overwrite: false,
      localizeImages: true
    });

    expect(r.ok).toBe(true);
    expect(r.images).toEqual({ local: 1, failed: 0, skipped: 0 });
    expect(imageFetches).toBe(1);
    const content = await readFile(r.path!, 'utf-8');
    expect(content).toMatch(/!\[photo\]\(images\/[a-f0-9]+\.png\)/);
    expect(content).not.toContain('https://cdn.example/photo.png');
  });

  it('keeps remote image URLs when localizeImages is disabled (default)', async () => {
    const htmlWithImage = `<!DOCTYPE html>
<html>
<head><title>Post Without Localize</title></head>
<body>
<article>
  <h1>Post Without Localize</h1>
  <p>This post has an image that should stay remote.</p>
  <img src="https://cdn.example/photo.png" alt="photo">
  <p>Trailing paragraph so Readability can detect the article body reliably.</p>
  <p>Another paragraph of body text to keep the article above length thresholds.</p>
</article>
</body>
</html>`;
    let imageFetches = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.startsWith('https://cdn.example/')) {
        imageFetches++;
        return new Response(new Uint8Array(Buffer.from('png')), { status: 200 });
      }
      return new Response(htmlWithImage, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;

    const r = await processUrl('https://example.com/post-remote', { outDir: dir, overwrite: false });

    expect(r.ok).toBe(true);
    expect(r.images).toBeUndefined();
    expect(imageFetches).toBe(0);
    const content = await readFile(r.path!, 'utf-8');
    expect(content).toContain('![photo](https://cdn.example/photo.png)');
  });

  it('downloads multiple images concurrently via imageOptions.concurrency', async () => {
    const htmlMulti = `<!DOCTYPE html>
<html>
<head><title>Multi Image Post</title></head>
<body>
<article>
  <h1>Multi Image Post</h1>
  <p>Post with several images.</p>
  <img src="https://cdn.example/a.png" alt="a">
  <p>Text between images.</p>
  <img src="https://cdn.example/b.png" alt="b">
  <p>More text.</p>
  <img src="https://cdn.example/c.png" alt="c">
  <p>Trailing paragraph so the article is detectable.</p>
  <p>Another paragraph to pad the article body length threshold.</p>
</article>
</body>
</html>`;
    let imageFetches = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.startsWith('https://cdn.example/')) {
        imageFetches++;
        return new Response(new Uint8Array(Buffer.from(u.slice(-6))), {
          status: 200,
          headers: { 'Content-Type': 'image/png' }
        });
      }
      return new Response(htmlMulti, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;

    const r = await processUrl('https://example.com/multi', {
      outDir: dir,
      overwrite: false,
      localizeImages: true,
      imageOptions: { concurrency: 3 }
    });

    expect(r.ok).toBe(true);
    expect(r.images).toEqual({ local: 3, failed: 0, skipped: 0 });
    expect(imageFetches).toBe(3);
    const content = await readFile(r.path!, 'utf-8');
    // All three images rewritten to local paths.
    const localRefs = content.match(/images\/[a-f0-9]+\.png/g) ?? [];
    expect(localRefs.length).toBe(3);
    expect(localRefs.every((s) => s.includes('.png'))).toBe(true);
    expect(content).not.toContain('https://cdn.example/a.png');
    expect(content).not.toContain('https://cdn.example/b.png');
    expect(content).not.toContain('https://cdn.example/c.png');
  });
});
