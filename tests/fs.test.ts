import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugify, writeMarkdown } from '../src/fs.js';

describe('slugify', () => {
  it('lowercases and replaces non-word runs with dashes', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('preserves CJK characters', () => {
    expect(slugify('中文 标题')).toBe('中文-标题');
  });

  it('falls back to "untitled" when input is empty after cleaning', () => {
    expect(slugify('!!!')).toBe('untitled');
  });

  it('trims trailing dashes', () => {
    expect(slugify('hello---')).toBe('hello');
  });

  it('caps length', () => {
    expect(slugify('a'.repeat(200), 20).length).toBeLessThanOrEqual(20);
  });
});

describe('writeMarkdown', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'webcopy-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes file with .md extension under outDir', async () => {
    const r = await writeMarkdown('# Hello', 'my-post', { outDir: dir, overwrite: false });
    expect(r.skipped).toBe(false);
    expect(r.path).toBe(join(dir, 'my-post.md'));
    const content = await readFile(r.path, 'utf-8');
    expect(content).toBe('# Hello');
  });

  it('skips existing file when overwrite=false', async () => {
    await writeMarkdown('# V1', 'dup', { outDir: dir, overwrite: false });
    const r = await writeMarkdown('# V2', 'dup', { outDir: dir, overwrite: false });
    expect(r.skipped).toBe(true);
    const content = await readFile(join(dir, 'dup.md'), 'utf-8');
    expect(content).toBe('# V1');
  });

  it('overwrites when overwrite=true', async () => {
    await writeMarkdown('# V1', 'dup', { outDir: dir, overwrite: false });
    await writeMarkdown('# V2', 'dup', { outDir: dir, overwrite: true });
    const content = await readFile(join(dir, 'dup.md'), 'utf-8');
    expect(content).toBe('# V2');
  });

  it('creates outDir recursively if missing', async () => {
    const nested = join(dir, 'a', 'b', 'c');
    const r = await writeMarkdown('# Nested', 'n', { outDir: nested, overwrite: false });
    expect(r.skipped).toBe(false);
    await expect(stat(r.path!)).resolves.toBeDefined();
  });
});
