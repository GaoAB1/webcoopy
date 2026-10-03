import type { ArticleAdapter, AdapterResult } from '../adapters.js';

/**
 * Convert a github.com blob URL to a raw.githubusercontent.com raw-text URL.
 *
 * Supported input shapes:
 *   - https://github.com/owner/repo/blob/main/README.md
 *   - https://github.com/owner/repo/blob/abc1234/README.md
 *   - https://github.com/owner/repo/blob/main/docs/README.md
 *   - https://github.com/owner/repo (bare repo → default README)
 *
 * Case is preserved on owner/repo/ref/path so `README.md` remains `README.md`.
 */
export function toRawUrl(url: string): string | null {
  const u = url.trim();
  if (!/^https?:\/\/(www\.)?github\.com\//i.test(u)) return null;

  const m = u.match(/^https?:\/\/(www\.)?github\.com\/([^\/]+)\/([^\/]+)(?:\/blob\/([^\/]+)\/(.+))?$/i);
  if (!m) return null;

  const [, , owner, repo, ref, path] = m;
  if (!owner || !repo) return null;

  // Strip any trailing query/anchor from the path (case preserved).
  const cleanPath = (path ?? 'README.md').split(/[?#]/)[0];
  const finalRef = ref ?? 'main';
  return `https://raw.githubusercontent.com/${owner}/${repo}/${finalRef}/${cleanPath}`;
}

/**
 * Adapter for GitHub README pages.
 * - resolveFetchUrl: redirects github.com/.../blob/... to raw.githubusercontent.com/...
 * - extract: treats the raw file as markdown directly (no HTML conversion).
 */
export const githubReadmeAdapter: ArticleAdapter = {
  name: 'github-readme',
  description: 'GitHub README files (fetched as raw markdown)',
  match(url: string) {
    return /^https?:\/\/(www\.)?github\.com\//i.test(url) && toRawUrl(url) !== null;
  },
  resolveFetchUrl(url: string) {
    return toRawUrl(url);
  },
  extract(_url: string, html: string, _pageUrl: string): AdapterResult {
    // The fetched content is already markdown — return as-is.
    // Trim a leading shebang if present (some tools add it).
    return { markdown: html.replace(/^#![^\n]*\n/, ''), siteName: 'github' };
  }
};
