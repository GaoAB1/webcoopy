import { describe, it, expect, vi, afterEach } from 'vitest';
import { Buffer } from 'node:buffer';
import * as iconv from 'iconv-lite';
import { detectCharset, decodeHtml, fetchHtml, FetchError } from '../src/fetcher.js';

describe('detectCharset', () => {
  it('prefers Content-Type header charset', () => {
    const buf = Buffer.from('<html><head></head><body></body></html>');
    const c = detectCharset(buf, 'text/html; charset=gbk');
    expect(c.toLowerCase()).toBe('gbk');
  });

  it('detects <meta charset="..."> in the first bytes', () => {
    const buf = Buffer.from('<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title></head><body></body></html>');
    expect(detectCharset(buf, 'text/html').toLowerCase()).toBe('utf-8');
  });

  it('detects <meta http-equiv="Content-Type"> with charset', () => {
    const html = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"><title>x</title></head><body></body></html>';
    const buf = Buffer.from(html);
    expect(detectCharset(buf, 'text/html').toLowerCase()).toBe('gb2312');
  });

  it('falls back to utf-8 when nothing is declared', () => {
    const buf = Buffer.from('<html><body>hello</body></html>');
    expect(detectCharset(buf, 'text/html')).toBe('utf-8');
  });
});

describe('decodeHtml', () => {
  it('decodes GBK content and returns valid UTF-8 string', () => {
    const original = '<html><body><p>你好，世界</p></body></html>';
    const gbkBytes = iconv.encode(original, 'gbk');
    const decoded = decodeHtml(gbkBytes, 'text/html; charset=gbk');
    expect(decoded).toContain('你好，世界');
  });

  it('decodes GB2312 content', () => {
    const original = '<html><body><p>测试</p></body></html>';
    const gb2312Bytes = iconv.encode(original, 'gb2312');
    const decoded = decodeHtml(gb2312Bytes, 'text/html; charset=gb2312');
    expect(decoded).toContain('测试');
  });

  it('decodes Shift-JIS content', () => {
    const original = '<html><body><p>こんにちは</p></body></html>';
    const sjisBytes = iconv.encode(original, 'shift_jis');
    const decoded = decodeHtml(sjisBytes, 'text/html; charset=shift_jis');
    expect(decoded).toContain('こんにちは');
  });

  it('passes through UTF-8 content unchanged', () => {
    const buf = Buffer.from('<html><body>hello 世界</body></html>');
    expect(decodeHtml(buf, 'text/html; charset=utf-8')).toContain('hello 世界');
  });

  it('falls back to UTF-8 for unknown charsets', () => {
    const buf = Buffer.from('<html><body>hello</body></html>');
    const decoded = decodeHtml(buf, 'text/html; charset=unknown-charset-xyz');
    expect(decoded).toContain('hello');
  });
});

describe('FetchError', () => {
  it('carries code, status, and cause', () => {
    const err = new FetchError('boom', 'http', 404);
    expect(err.code).toBe('http');
    expect(err.status).toBe(404);
    expect(err.name).toBe('FetchError');
    expect(err.message).toBe('boom');
  });
});

describe('fetchHtml browserMode headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureHeaders(): { headers: Record<string, unknown>; calls: number } {
    const state = { headers: {} as Record<string, unknown>, calls: 0 };
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      state.calls++;
      state.headers = (init?.headers ?? {}) as Record<string, unknown>;
      return new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });
    }));
    return state;
  }

  it('sends real-browser headers when browserMode is set', async () => {
    const state = captureHeaders();
    await fetchHtml('https://example.com/a', { browserMode: true, retries: 1 });

    const h = state.headers as Record<string, string>;
    expect(h['User-Agent']).toContain('Chrome/');
    expect(h['sec-fetch-mode']).toBe('navigate');
    expect(h['sec-ch-ua']).toContain('Chromium');
    expect(h['Accept-Language']).toMatch(/^zh-CN/);
  });

  it('keeps the lightweight bot headers by default', async () => {
    const state = captureHeaders();
    await fetchHtml('https://example.com/a', { retries: 1 });

    const h = state.headers as Record<string, string>;
    expect(h['User-Agent']).toContain('webcopy/');
    expect(h['sec-fetch-mode']).toBeUndefined();
  });

  it('lets explicit userAgent override the browser profile', async () => {
    const state = captureHeaders();
    await fetchHtml('https://example.com/a', { browserMode: true, userAgent: 'custom/1.0', retries: 1 });

    const h = state.headers as Record<string, string>;
    expect(h['User-Agent']).toBe('custom/1.0');
    expect(h['sec-fetch-mode']).toBe('navigate');
  });
});
