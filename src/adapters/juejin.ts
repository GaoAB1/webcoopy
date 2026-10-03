import { load } from 'cheerio';
import type { ArticleAdapter, AdapterResult } from '../adapters.js';

/**
 * Adapter for Juejin.cn articles.
 *
 * URL shape: https://juejin.cn/post/{id}
 *
 * Strategy (in order):
 *
 * 1. **SSR payload** — Juejin is a Nuxt SPA. The server ships the article as a
 *    JS payload (`window.__NUXT__=(function(...){...})(...)`) and the client
 *    renders it. The DOM therefore contains no `.article-content` element on a
 *    plain HTTP fetch, so DOM scraping alone always fails. Crucially, the
 *    payload's `mark_content` field already holds the article as **Markdown**,
 *    so it is returned as-is and the converter is bypassed entirely.
 *
 * 2. **DOM fallback** — if the payload is absent (older pages, layout changes),
 *    fall back to `.article-content` + turndown, as before.
 *
 * Why this matters: without step 1, extraction returned an empty body, the
 * pipeline fell through to Readability, and Readability — finding no article in
 * the SPA shell — picked up the loading placeholder ("Please wait...") and
 * wrote that as the whole document.
 */
export const juejinAdapter: ArticleAdapter = {
  name: 'juejin',
  description: 'Juejin.cn articles (SSR payload + DOM fallback)',
  match(url: string) {
    return /^https?:\/\/juejin\.cn\/post\//i.test(url);
  },
  extract(_url: string, html: string, _pageUrl: string): AdapterResult {
    const payload = extractNuxtArticle(html);
    if (payload?.markContent) {
      return {
        markdown: stripLeadingFrontMatter(payload.markContent),
        title: normalizeTitle(payload.title) || undefined,
        byline: payload.author || undefined,
        siteName: 'juejin'
      };
    }

    const domResult = extractFromDom(html);
    if (domResult.html !== undefined) return domResult;

    // Both paths failed. Juejin intermittently serves a bot-degraded response
    // (challenge page or CSR shell without the SSR payload). Ask the pipeline
    // to retry once with full browser headers before giving up.
    return { html: undefined, retryWithBrowser: true };
  }
};

/**
 * Juejin prepends its own `---\ntheme: juejin\n---` block to `mark_content`.
 * The pipeline writes a real front-matter block of its own, so leaving this in
 * produces two stacked YAML headers in the output file.
 */
function stripLeadingFrontMatter(markdown: string): string {
  const m = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!m) return markdown;
  // Only strip when the block looks like the theme header, not article content.
  if (!/theme\s*:/i.test(m[0])) return markdown;
  return markdown.slice(m[0].length).replace(/^\s*\n/, '');
}

interface NuxtArticle {
  markContent?: string;
  title?: string;
  author?: string;
}

/**
 * Pull `mark_content` (and a couple of companions) out of the Nuxt SSR payload.
 *
 * The payload is a JS object literal produced by an IIFE, so it is not valid
 * JSON and cannot simply be `JSON.parse`d. Rather than evaluating it (unsafe),
 * we scan for the known keys and read their string literals directly, which is
 * robust against the minified variable-alias soup in between.
 */
export function extractNuxtArticle(html: string): NuxtArticle | null {
  if (!html.includes('__NUXT__')) return null;

  // The article lives in the `article` key of the payload. Narrow to the region
  // around it so we do not accidentally pick up unrelated `title:` fields
  // (e.g. the site's own nav entries like `title:"推荐"`).
  const anchor = html.search(/["']?article["']?\s*:\s*\{/);
  const searchRegion = anchor >= 0 ? html.slice(anchor) : html;

  const markContent = readStringLiteral(searchRegion, 'mark_content');
  if (!markContent) return null;

  // The article's own `title` is minified to a single-letter alias (e.g.
  // `title:y`) inside the Nuxt IIFE, so it cannot be read by key. The page
  // <title> holds the real heading (plus an SEO suffix) — clean that instead.
  const title = normalizeTitle(firstTagText(html, 'title'));

  // The author is likewise aliased; `user_name` is only present when the
  // payload happens to keep the key, so this is best-effort.
  const author = readStringLiteral(searchRegion, 'user_name') ?? undefined;

  return { markContent, title, author };
}

/**
 * Read a `key:"value"` string literal from a JS object literal, correctly
 * unescaping the JS escapes used inside it (`\"`, `\\`, `\n`, `\uXXXX`, and
 * the `\u002F` form Juejin uses for slashes in URLs).
 */
function readStringLiteral(source: string, key: string): string | null {
  const keyRe = new RegExp(`(?:^|[,{])["']?${escapeRegExp(key)}["']?\\s*:\\s*"`);
  const m = keyRe.exec(source);
  if (!m) return null;

  let i = m.index + m[0].length; // first char inside the string
  let out = '';

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\') {
      const next = source[i + 1];
      switch (next) {
        case 'n': out += '\n'; i += 2; continue;
        case 't': out += '\t'; i += 2; continue;
        case 'r': out += '\r'; i += 2; continue;
        case '"': out += '"'; i += 2; continue;
        case "'": out += "'"; i += 2; continue;
        case '\\': out += '\\'; i += 2; continue;
        case '/': out += '/'; i += 2; continue;
        case 'u': {
          const hex = source.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            const code = parseInt(hex, 16);
            // Surrogate pair handling.
            if (code >= 0xd800 && code <= 0xdbff) {
              const lo = source.slice(i + 6, i + 12);
              if (/^\\u[0-9a-fA-F]{4}$/.test(lo)) {
                const low = parseInt(lo.slice(2), 16);
                out += String.fromCharCode(code, low);
                i += 12;
                continue;
              }
            }
            out += String.fromCharCode(code);
            i += 6;
            continue;
          }
          out += next;
          i += 2;
          continue;
        }
        default:
          out += next ?? '';
          i += 2;
          continue;
      }
    }

    if (ch === '"') break; // closing quote
    out += ch;
    i++;
  }

  return out.length > 0 ? out : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstTagText(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

/** Strip the " - 掘金" suffix Juejin appends to page titles. */
function normalizeTitle(title?: string | null): string {
  if (!title) return '';
  return title.replace(/\s*-\s*掘金\s*$/, '').trim();
}

/**
 * Legacy DOM path: works when the server rendered the article inline (or when
 * a page snapshot is used in tests). Returns `html: undefined` when nothing
 * usable is found so the pipeline can fall through to Readability.
 */
function extractFromDom(html: string): AdapterResult {
  const $ = load(html);
  let title = '';
  let byline = '';

  const h1 = $('h1').first();
  if (h1.length && h1.text().trim()) title = h1.text().trim();
  if (!title) {
    title = normalizeTitle($('title').first().text().trim());
  }

  const authorEl = $('.daohang-author-name, .d-pf-name, .author-name, [class*="AuthorName"]').first();
  if (authorEl.length && authorEl.text().trim()) byline = authorEl.text().trim();

  const bodyEl = $('.article-content, [class*="article-content"], article').first();
  if (!bodyEl.length || $(bodyEl).text().trim().length < 100) {
    return { html: undefined };
  }

  let bodyHtml = bodyEl.html() ?? '';
  const $body = load(bodyHtml);

  $body('.article-menu, .article-toc, [class*="TOC"], [class*="Menu"]').remove();
  $body('.comment-container, .juejin-comment, [class*="Comment"], ' +
        '.like-button, [class*="Like"], [class*="Share"], [class*="Recommend"], ' +
        '.d-article-footer, .article-footer, .d-pref, [class*="Tag"]').remove();

  for (const el of $body('a').toArray()) {
    const e = $(el);
    if (!e.text().trim() && !e.find('img').length) e.remove();
  }

  $body('script').remove();
  bodyHtml = $body.root().html() ?? bodyHtml;

  return {
    html: bodyHtml,
    title: title || undefined,
    byline: byline || undefined,
    siteName: 'juejin'
  };
}
