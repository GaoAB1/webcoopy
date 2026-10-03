import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import {
  extractImageUrls,
  extForUrl,
  localizeImages,
  type ImageDownload
} from '../src/images.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'webcopy-img-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function bytes(n: number): Uint8Array {
  return new Uint8Array(n);
}

describe('extForUrl', () => {
  it('uses Content-Type when it maps to a known extension', () => {
    expect(extForUrl('https://x.example/img', 'image/png')).toBe('png');
    expect(extForUrl('https://x.example/img', 'image/jpeg')).toBe('jpg');
    expect(extForUrl('https://x.example/img', 'image/jpeg; charset=binary')).toBe('jpg');
    expect(extForUrl('https://x.example/img', 'IMAGE/PNG')).toBe('png');
  });

  it('falls back to the URL path extension', () => {
    expect(extForUrl('https://x.example/a.png', '')).toBe('png');
    expect(extForUrl('https://x.example/a.webp?sig=abc', '')).toBe('webp');
    expect(extForUrl('https://x.example/a', '')).toBe('bin');
  });

  it('prefers Content-Type over URL extension', () => {
    expect(extForUrl('https://x.example/a.foo', 'image/png')).toBe('png');
  });
});

describe('extractImageUrls', () => {
  it('returns unique http(s) URLs in first-seen order', () => {
    const md = [
      '![a](https://cdn.example/1.png)',
      '![b](https://cdn.example/2.jpg "caption")',
      '![again](https://cdn.example/1.png)'
    ].join('\n');
    expect(extractImageUrls(md)).toEqual([
      'https://cdn.example/1.png',
      'https://cdn.example/2.jpg'
    ]);
  });

  it('skips data:, protocol-relative, and relative URLs', () => {
    const md = [
      '![d](data:image/png;base64,AAA)',
      '![r](//cdn.example/x.png)',
      '![p](./local.png)',
      '![p2](images/other.png)',
      '![r3](#anchor)',
      '![http](http://cdn.example/1.png)'
    ].join('\n');
    expect(extractImageUrls(md)).toEqual(['http://cdn.example/1.png']);
  });

  it('handles URLs with query strings and returns empty array when none', () => {
    const md = '![a](https://cdn.example/img.png?sig=abc&t=2) and ![b](https://cdn.example/i2.png)';
    expect(extractImageUrls(md)).toEqual([
      'https://cdn.example/img.png?sig=abc&t=2',
      'https://cdn.example/i2.png'
    ]);
    expect(extractImageUrls('no images here')).toEqual([]);
  });
});

describe('localizeImages', () => {
  it('downloads remote images, rewrites URLs, and skips data:/relative URLs', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let calls = 0;
    const md = [
      '# Article',
      '',
      '![remote](https://cdn.example/1.png)',
      '',
      '![data](data:image/png;base64,AAA)',
      '',
      '![relative](./local.png)'
    ].join('\n');

    const { markdown, local, failed, skipped } = await localizeImages(md, {
      outDir: dir,
      slug: 'article-slug',
      fetcher: async () => {
        calls++;
        return { data: pngBytes, contentType: 'image/png' } satisfies ImageDownload;
      }
    });

    expect(local).toBe(1);
    expect(failed).toBe(0);
    expect(skipped).toBe(0); // data:/relative are filtered before we even call the fetcher.
    expect(calls).toBe(1);
    expect(markdown).toContain('![remote](images/');
    expect(markdown).toMatch(/images\/[a-f0-9]+\.png/);
    // Non-remote URLs untouched.
    expect(markdown).toContain('![data](data:image/png;base64,AAA)');
    expect(markdown).toContain('![relative](./local.png)');

    // File was written with the SHA1-derived name.
    const files = await readdir(join(dir, 'article-slug', 'images'));
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith('.png')).toBe(true);
    const written = await readFile(join(dir, 'article-slug', 'images', files[0]!));
    expect(written.equals(pngBytes)).toBe(true);
  });

  it('deduplicates identical URLs across the document and across bytes', async () => {
    const a = Buffer.from('AAA');
    const b = Buffer.from('BBB');
    const md = [
      '![1](https://cdn.example/a)',
      '![again](https://cdn.example/a)',
      '![2](https://cdn.example/b)'
    ].join('\n');

    let calls = 0;
    const { markdown, local, failed, skipped } = await localizeImages(md, {
      outDir: dir,
      slug: 'dedup',
      fetcher: async (url) => {
        calls++;
        const data = url.endsWith('/a') ? a : b;
        return { data, contentType: 'image/gif' } satisfies ImageDownload;
      }
    });

    expect(local).toBe(2); // only two distinct URLs
    expect(failed).toBe(0);
    expect(skipped).toBe(0);
    expect(calls).toBe(2);

    // Both occurrences of a rewritten to the same local path.
    const matches = [...markdown.matchAll(/images\/[a-f0-9]+\.gif/g)];
    expect(matches).toHaveLength(3); // three rewritten URLs total (two a, one b)
    const distinct = new Set(matches.map((m) => m[0]));
    expect(distinct.size).toBe(2);
  });

  it('infers extension from Content-Type, then from URL path', async () => {
    // URLs chosen so they don't substring-collide: `/typed` vs `/plain`.
    const md = [
      '![t](https://cdn.example/typed)',
      '![u](https://cdn.example/plain.png)'
    ].join('\n');

    const { markdown } = await localizeImages(md, {
      outDir: dir,
      slug: 'ext',
      fetcher: async (url) => {
        const isTyped = url.endsWith('/typed');
        // Different content so hashes differ; each URL exercises a different
        // extension-inference path.
        const data = isTyped ? Buffer.from('webp-payload') : Buffer.from('png-payload');
        const contentType = isTyped ? 'image/webp' : '';
        return { data, contentType } satisfies ImageDownload;
      }
    });

    expect(markdown).toContain('.webp');
    expect(markdown).toContain('.png');
  });

  it('keeps the original URL when the fetcher throws', async () => {
    const md = [
      '![ok](https://cdn.example/ok.png)',
      '![fail](https://cdn.example/missing.png)'
    ].join('\n');

    const { markdown, local, failed, skipped } = await localizeImages(md, {
      outDir: dir,
      slug: 'partial',
      fetcher: async (url) => {
        if (url.endsWith('missing.png')) throw new Error('boom');
        return { data: Buffer.from('img'), contentType: 'image/png' } satisfies ImageDownload;
      }
    });

    expect(local).toBe(1);
    expect(failed).toBe(1);
    expect(skipped).toBe(0);
    expect(markdown).toContain('![ok](images/');
    expect(markdown).toContain('![fail](https://cdn.example/missing.png)');
  });

  it('skips oversized responses (maxBytes) without failing', async () => {
    const md = '![big](https://cdn.example/big.png)';
    const { markdown, local, failed, skipped } = await localizeImages(md, {
      outDir: dir,
      slug: 'max',
      maxBytes: 5,
      fetcher: async () => ({ data: bytes(10), contentType: 'image/png' })
    });

    expect(local).toBe(0);
    expect(failed).toBe(0);
    expect(skipped).toBe(1);
    expect(markdown).toBe(md);
  });

  it('returns the markdown unchanged when there are no remote images', async () => {
    const md = '# No images here\n\nJust text and ![inline](./local.png).';
    const { markdown, local, failed, skipped } = await localizeImages(md, {
      outDir: dir,
      slug: 'none',
      fetcher: async () => {
        throw new Error('should not be called');
      }
    });
    expect(markdown).toBe(md);
    expect(local).toBe(0);
    expect(failed).toBe(0);
    expect(skipped).toBe(0);
  });

  it('preserves inline image titles when rewriting', async () => {
    const md = '![alt](https://cdn.example/x.png "My caption")';
    const { markdown } = await localizeImages(md, {
      outDir: dir,
      slug: 'title',
      fetcher: async () => ({ data: Buffer.from('x'), contentType: 'image/png' })
    });
    expect(markdown).toMatch(/^!\[alt\]\(images\/[a-f0-9]+\.png "My caption"\)$/);
  });

  describe('concurrency', () => {
    /** Wrap a fetcher to track how many requests are in-flight at once. */
    function trackingFetcher(inner: (url: string) => Promise<ImageDownload>) {
      let inFlight = 0;
      let peak = 0;
      const fn = async (url: string): Promise<ImageDownload> => {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        try {
          return await inner(url);
        } finally {
          inFlight--;
        }
      };
      return { fn, getPeak: () => peak, getInFlight: () => inFlight };
    }

    it('respects concurrency=1 (strict serial)', async () => {
      const md = Array.from({ length: 5 }, (_, i) => `![${i}](https://cdn.example/i${i}.png)`).join('\n');
      const t = trackingFetcher(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { data: Buffer.from('x'), contentType: 'image/png' };
      });
      await localizeImages(md, {
        outDir: dir,
        slug: 'serial',
        concurrency: 1,
        fetcher: t.fn
      });
      expect(t.getPeak()).toBe(1);
    });

    it('saturates up to concurrency=N but never exceeds it', async () => {
      const md = Array.from({ length: 10 }, (_, i) => `![${i}](https://cdn.example/i${i}.png)`).join('\n');
      const t = trackingFetcher(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { data: Buffer.from('y'), contentType: 'image/png' };
      });
      await localizeImages(md, {
        outDir: dir,
        slug: 'parallel-4',
        concurrency: 4,
        fetcher: t.fn
      });
      expect(t.getPeak()).toBeLessThanOrEqual(4);
      expect(t.getPeak()).toBeGreaterThan(1);
    });

    it('isolates failures — one failing URL does not block the others', async () => {
      const md = [
        '![ok1](https://cdn.example/ok1.png)',
        '![fail](https://cdn.example/fail.png)',
        '![ok2](https://cdn.example/ok2.png)'
      ].join('\n');

      const { markdown, local, failed, skipped } = await localizeImages(md, {
        outDir: dir,
        slug: 'isolation',
        concurrency: 3,
        fetcher: async (url) => {
          if (url.endsWith('fail.png')) throw new Error('boom');
          return { data: Buffer.from('good'), contentType: 'image/png' };
        }
      });

      expect(local).toBe(2);
      expect(failed).toBe(1);
      expect(skipped).toBe(0);
      expect(markdown).toContain('https://cdn.example/fail.png');
      expect(markdown).toContain('![ok1](images/');
      expect(markdown).toContain('![ok2](images/');
    });

    it('handles concurrency larger than the URL count without over-running', async () => {
      const md = '![1](https://cdn.example/a.png)\n![2](https://cdn.example/b.png)';
      const t = trackingFetcher(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { data: Buffer.from('z'), contentType: 'image/png' };
      });
      await localizeImages(md, {
        outDir: dir,
        slug: 'few',
        concurrency: 8,
        fetcher: t.fn
      });
      // Only 2 URLs, so at most 2 in-flight even though concurrency=8.
      expect(t.getPeak()).toBe(2);
    });

    it('uses the default concurrency (4) when not specified', async () => {
      const md = '![a](https://cdn.example/a.png)';
      const { markdown } = await localizeImages(md, {
        outDir: dir,
        slug: 'default-conc',
        fetcher: async () => ({ data: Buffer.from('a'), contentType: 'image/png' })
      });
      expect(markdown).toContain('images/');
    });
  });
});
