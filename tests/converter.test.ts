import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { htmlToMarkdown } from '../src/converter.js';

const FIX = (name: string) =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');

describe('converter on real fixtures', () => {
  it('blog-post: preserves heading hierarchy and blockquote', () => {
    const out = htmlToMarkdown(FIX('blog-post.html'), {
      pageUrl: 'https://example.com/blog/hello-world'
    });
    expect(out).toContain('# Hello, World');
    expect(out).toContain('## Section 2');
    expect(out).toContain('> Stay curious.');
    expect(out).toContain('[section 2](#section-2)');
    expect(out).toContain('https://example.com/img/pic.png');
  });

  it('docs-with-code: preserves code block languages', () => {
    const out = htmlToMarkdown(FIX('docs-with-code.html'));
    expect(out).toContain('```js');
    expect(out).toContain('function greet(name)');
    expect(out).toContain('```python');
    expect(out).toContain('def greet(name):');
    expect(out).toContain('```bash');
  });

  it('table-heavy: renders GFM tables and task list', () => {
    const out = htmlToMarkdown(FIX('table-heavy.html'));
    expect(out).toContain('| Plan | Users | Price |');
    expect(out).toContain('| Free | 1 | $0 |');
    expect(out).toContain('[x]');
  });
});
