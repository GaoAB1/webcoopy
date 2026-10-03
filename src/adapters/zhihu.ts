import { load } from 'cheerio';
import type { ArticleAdapter, AdapterResult } from '../adapters.js';

/**
 * Adapter for Zhihu answers and articles.
 *
 * Readability often misses the answer body because Zhihu renders content
 * inside deeply nested `.Card-content` divs with lazy-loaded images.
 *
 * Strategy:
 *  - Match zhihu.com question/answer URLs and zhihu.com/p/{id} (articles)
 *  - Extract the article body from common containers
 *  - Rewrite lazy-loaded images: `data-src` → `src`
 *  - Strip vote buttons, share bars, and other chrome
 */
export const zhihuAdapter: ArticleAdapter = {
  name: 'zhihu',
  description: 'Zhihu answers and articles',
  match(url: string) {
    return /^https?:\/\/(www\.)?zhihu\.com\//i.test(url) &&
      (
        /\/question\/\d+\/answer\/\d+/.test(url) ||
        /\/p\/\d+/.test(url) ||
        /\/answer\/\d+/.test(url)
      );
  },
  extract(url: string, html: string, _pageUrl: string): AdapterResult {
    const $ = load(html);
    let title = '';
    let byline = '';

    // Title from <h1> or <title>.
    const h1 = $('h1').first();
    if (h1.length && h1.text().trim()) title = h1.text().trim();
    if (!title) title = $('title').first().text().trim();

    // Byline: look for a plausible author link.
    const candidates = $('a[href^="/"]').toArray();
    for (const el of candidates) {
      const $el = $(el);
      if ($el.find('.AvatarLink').length > 0 || $el.attr('class') === 'AuthorInfo-name') {
        const t = $el.text().trim();
        if (t) { byline = t; break; }
      }
    }

    // Body: try multiple containers, take the first with substantial content.
    const selectors = [
      'div[class*="RichContent"][class*="QuestionRichText"]',
      'div[class*="RichContent"][class*="Post-RichTextContainer"]',
      'div.AnswerCard',
      'div.Card-content',
      'article',
      'div.AnswerRichContent',
      'div.PCContent'
    ];

    let bodyHtml = '';
    let bestTextLen = 0;
    for (const sel of selectors) {
      const matches = $(sel).toArray();
      for (const el of matches) {
        const text = $(el).text().trim();
        if (text.length > bestTextLen) {
          bestTextLen = text.length;
          bodyHtml = $(el).html() ?? '';
        }
      }
      if (bestTextLen > 200) break;
    }

    if (!bodyHtml) {
      // No suitable container — let the caller fall back to Readability.
      return { html: undefined };
    }

    // Post-process: rewrite lazy images and strip noise.
    const $body = load(bodyHtml);

    // Rewrite lazy-loaded image sources: data-actualsrc → src.
    for (const el of $body('img').toArray()) {
      const e = $(el);
      const src = e.attr('data-actualsrc') ?? e.attr('data-src');
      if (src) e.attr('src', src);
    }

    // Remove noise: vote buttons, share bars, other chrome.
    $body('.VoteButton, .AnswerActions, .Card-header--user, .Card-content--action, ' +
          '.RichContent--more, .Share-bar, .QuoteCard, .AuthorAnswerList').remove();

    // Remove empty anchor elements (fold markers).
    for (const el of $body('a').toArray()) {
      const e = $(el);
      if (!e.text().trim()) e.remove();
    }

    return {
      html: $body.root().html() ?? bodyHtml,
      title: title || undefined,
      byline: byline || undefined,
      siteName: 'zhihu'
    };
  }
};
