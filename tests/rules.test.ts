import { describe, it, expect } from 'vitest';
import { extractCodeLanguage, addCodeBlockRule } from '../src/rules/code-block.js';
import { addImageRule } from '../src/rules/image.js';
import { addLinkRule } from '../src/rules/link.js';
import { htmlToMarkdown } from '../src/converter.js';

describe('code-block rule', () => {
  it('extracts language from class="language-js"', () => {
    const el = document.createElement('code');
    el.className = 'language-js';
    expect(extractCodeLanguage(el)).toBe('js');
  });

  it('extracts language from class="lang-python"', () => {
    const el = document.createElement('code');
    el.className = 'lang-python';
    expect(extractCodeLanguage(el)).toBe('python');
  });

  it('extracts language from data-lang', () => {
    const el = document.createElement('code');
    el.setAttribute('data-lang', 'bash');
    expect(extractCodeLanguage(el)).toBe('bash');
  });

  it('extracts language from GitHub highlight-text- class', () => {
    const el = document.createElement('pre');
    el.className = 'highlight-text-bash';
    expect(extractCodeLanguage(el)).toBe('bash');
  });

  it('returns empty string when no language info is present', () => {
    const el = document.createElement('code');
    expect(extractCodeLanguage(el)).toBe('');
  });
});

describe('htmlToMarkdown integration', () => {
  it('preserves code block language from <code class="language-js">', () => {
    const html = '<pre><code class="language-js">const a = 1;</code></pre>';
    const out = htmlToMarkdown(html);
    expect(out).toContain('```js');
    expect(out).toContain('const a = 1;');
  });

  it('renders images with alt text', () => {
    const html = '<p><img src="https://x.test/a.png" alt="A"></p>';
    const out = htmlToMarkdown(html);
    expect(out).toContain('![A](https://x.test/a.png)');
  });

  it('skips images with empty src', () => {
    const html = '<p><img src="" alt="hidden"></p>';
    const out = htmlToMarkdown(html);
    expect(out).not.toContain('![');
  });

  it('preserves anchor-only links as-is', () => {
    const html = '<p>See <a href="#section-2">section 2</a>.</p>';
    const out = htmlToMarkdown(html);
    expect(out).toContain('[section 2](#section-2)');
  });

  it('renders normal links', () => {
    const html = '<p>Visit <a href="https://example.com">example</a>.</p>';
    const out = htmlToMarkdown(html);
    expect(out).toContain('[example](https://example.com)');
  });
});

describe('image URL absolutization', () => {
  it('rewrites relative img src using pageUrl', () => {
    const html = '<p><img src="/img/pic.png" alt="p"></p>';
    const out = htmlToMarkdown(html, { pageUrl: 'https://example.com/blog/post' });
    expect(out).toContain('![p](https://example.com/img/pic.png)');
  });

  it('leaves absolute img src unchanged', () => {
    const html = '<p><img src="https://cdn.test/a.png" alt="a"></p>';
    const out = htmlToMarkdown(html, { pageUrl: 'https://example.com/blog/post' });
    expect(out).toContain('https://cdn.test/a.png');
  });

  it('leaves data: URIs unchanged', () => {
    const html = '<p><img src="data:image/png;base64,AAA" alt="d"></p>';
    const out = htmlToMarkdown(html, { pageUrl: 'https://example.com/x' });
    expect(out).toContain('data:image/png;base64,AAA');
  });
});

describe('gfm extensions', () => {
  it('renders tables', () => {
    const html = '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    const out = htmlToMarkdown(html);
    expect(out).toContain('| A | B |');
    expect(out).toContain('| 1 | 2 |');
  });

  it('renders strikethrough (single-tilde per turndown-plugin-gfm)', () => {
    const html = '<p><del>gone</del></p>';
    const out = htmlToMarkdown(html);
    expect(out).toContain('~gone~');
  });

  it('renders task list items', () => {
    const html = '<ul><li><input type="checkbox" checked>Done</li></ul>';
    const out = htmlToMarkdown(html);
    expect(out).toMatch(/\[x\]\s*Done|\[x\] Done/);
  });
});
