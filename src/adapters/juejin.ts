import { load } from 'cheerio';
import type { ArticleAdapter, AdapterResult } from '../adapters.js';

/**
 * Adapter for Juejin.cn articles.
 *
 * URL shape: https://juejin.cn/post/{id}
 *
 * DOM strategy:
 *  - Title: <h1> inside .article-container (or fallback to <title>)
 *  - Author: .daohang-author-name or .d-pf-name
 *  - Body: .article-content
 *  - Code blocks: <pre> with <code> — often have language classes
 *  - Images: <img> with normal src
 *  - Strip noise: sidebar, comments, recommendations, TOC, tags, likes
 */
export const juejinAdapter: ArticleAdapter = {
  name: 'juejin',
  description: 'Juejin.cn articles',
  match(url: string) {
    return /^https?:\/\/juejin\.cn\/post\//i.test(url);
  },
  extract(_url: string, html: string, _pageUrl: string): AdapterResult {
    const $ = load(html);
    let title = '';
    let byline = '';

    // Title: first h1, or <title>.
    const h1 = $('h1').first();
    if (h1.length && h1.text().trim()) title = h1.text().trim();
    if (!title) {
      title = $('title').first().text().trim();
      // Strip common suffixes like " - 掘金".
      title = title.replace(/\s*-\s*掘金\s*$/, '').trim();
    }

    // Author.
    const authorEl = $('.daohang-author-name, .d-pf-name, .author-name, [class*="AuthorName"]').first();
    if (authorEl.length && authorEl.text().trim()) byline = authorEl.text().trim();

    // Body.
    const bodyEl = $('.article-content, [class*="article-content"], article').first();
    if (!bodyEl.length || $(bodyEl).text().trim().length < 100) {
      return { html: undefined };
    }

    let bodyHtml = bodyEl.html() ?? '';

    // Juejin sometimes nests a wrapper div — unwrap one level if present.
    const $body = load(bodyHtml);

    // Remove TOC sidebar if it leaked in.
    $body('.article-menu, .article-toc, [class*="TOC"], [class*="Menu"]').remove();

    // Remove comment section, like bar, share buttons.
    $body('.comment-container, .juejin-comment, [class*="Comment"], ' +
          '.like-button, [class*="Like"], [class*="Share"], [class*="Recommend"], ' +
          '.d-article-footer, .article-footer, .d-pref, [class*="Tag"]').remove();

    // Remove empty anchors.
    for (const el of $body('a').toArray()) {
      const e = $(el);
      if (!e.text().trim() && !e.find('img').length) e.remove();
    }

    // Remove scripts.
    $body('script').remove();

    bodyHtml = $body.root().html() ?? bodyHtml;

    return {
      html: bodyHtml,
      title: title || undefined,
      byline: byline || undefined,
      siteName: 'juejin'
    };
  }
};
