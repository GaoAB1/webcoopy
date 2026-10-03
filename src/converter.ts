import TurndownService from 'turndown';
import { tables, strikethrough, taskListItems, highlightedCodeBlock } from 'turndown-plugin-gfm';
import { load } from 'cheerio';

import { addCodeBlockRule } from './rules/code-block.js';
import { addImageRule } from './rules/image.js';
import { addLinkRule } from './rules/link.js';

export interface ConverterOptions {
  /**
   * If provided, all relative image URLs in the article HTML are rewritten
   * to absolute URLs based on this page URL before conversion.
   */
  pageUrl?: string;
}

/**
 * Create a configured turndown service with:
 *  - GFM extensions (tables, strikethrough, task lists, highlighted code blocks)
 *  - Custom rules for code block language, images, and links
 */
export function createConverter(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    fence: '```',
    hr: '---'
  });

  // GFM extensions (register after defaults so overrides take effect).
  service.use([tables, strikethrough, taskListItems, highlightedCodeBlock]);

  // Custom rules (registered after all defaults to win precedence).
  addCodeBlockRule(service);
  addImageRule(service);
  addLinkRule(service);

  return service;
}

/**
 * Rewrite all img[src] from relative to absolute using the given page URL.
 * Does nothing if pageUrl is missing.
 */
export function absolutizeImageUrls(html: string, pageUrl?: string): string {
  if (!pageUrl) return html;

  const base = new URL(pageUrl);
  const $ = load(html);

  $('img').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    // Already absolute, protocol-relative, or data: — leave as-is.
    if (/^(https?:|data:|\/\/)/i.test(src)) return;
    if (src.startsWith('#') || src.startsWith('?')) return;

    try {
      const abs = new URL(src, base).href;
      $(el).attr('src', abs);
    } catch {
      // Ignore malformed URLs; leave unchanged.
    }
  });

  return $.root().html() ?? html;
}

/**
 * Convert article HTML to Markdown.
 */
export function htmlToMarkdown(html: string, options: ConverterOptions = {}): string {
  const preprocessed = absolutizeImageUrls(html, options.pageUrl);
  const converter = createConverter();
  return converter.turndown(preprocessed);
}
