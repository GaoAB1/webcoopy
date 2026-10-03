import { describe, it, expect } from 'vitest';
import { buildFrontMatter, renderDocument } from '../src/meta.js';

describe('buildFrontMatter', () => {
  it('includes required fields in order', () => {
    const fm = buildFrontMatter({
      title: 'My Post',
      author: 'Jane',
      siteName: 'example.com',
      source: 'https://example.com/my-post',
      fetchedAt: new Date('2026-10-01T12:00:00.000Z')
    });
    expect(fm).toContain('---');
    expect(fm).toContain('title: "My Post"');
    expect(fm).toContain('author: "Jane"');
    expect(fm).toContain('site: "example.com"');
    expect(fm).toContain('source: "https://example.com/my-post"');
    expect(fm).toContain('fetched_at: "2026-10-01T12:00:00.000Z"');
  });

  it('escapes double quotes in values', () => {
    const fm = buildFrontMatter({
      title: 'Say "hi"',
      source: 'https://example.com',
      fetchedAt: new Date('2026-10-01T12:00:00.000Z')
    });
    expect(fm).toContain('title: "Say \\"hi\\""');
  });

  it('omits author and site when not provided', () => {
    const fm = buildFrontMatter({
      title: 'T',
      source: 'https://x.test/',
      fetchedAt: new Date('2026-10-01T12:00:00.000Z')
    });
    expect(fm).not.toContain('author:');
    expect(fm).not.toContain('site:');
  });
});

describe('renderDocument', () => {
  it('joins front-matter and body with a blank line', () => {
    const fm = '---\ntitle: "T"\n---';
    const body = '# Hello\n\nworld';
    const out = renderDocument(fm, body);
    expect(out.startsWith('---')).toBe(true);
    expect(out).toContain('---\n\n# Hello');
    expect(out.endsWith('\n')).toBe(true);
  });
});
