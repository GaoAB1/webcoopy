import { writeFile, access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Sanitize a title into a filename-safe slug.
 * - Lowercases and replaces runs of non-word chars with a single dash.
 * - Trims trailing dashes.
 * - Falls back to 'untitled' if empty.
 * - Caps length to avoid filesystem limits.
 */
export function slugify(title: string, maxLength = 80): string {
  const cleaned = title
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^\w\u4e00-\u9fff]+/g, '-') // keep CJK characters
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  return cleaned || 'untitled';
}

export interface WriteOptions {
  outDir: string;
  overwrite: boolean;
}

export interface WriteResult {
  path: string;
  skipped: boolean;
}

/**
 * Write markdown content to `<outDir>/<slug>.md`.
 * Skips existing files unless overwrite is true.
 */
export async function writeMarkdown(
  content: string,
  slug: string,
  options: WriteOptions
): Promise<WriteResult> {
  await mkdir(options.outDir, { recursive: true });
  const filePath = join(options.outDir, `${slug}.md`);

  if (!options.overwrite) {
    try {
      await access(filePath);
      return { path: filePath, skipped: true };
    } catch {
      // Doesn't exist — proceed to write.
    }
  }

  await writeFile(filePath, content, 'utf-8');
  return { path: filePath, skipped: false };
}
