import { load } from 'cheerio';
import type { ArticleAdapter, AdapterResult } from '../adapters.js';

/**
 * Adapter for WeChat Official Account articles (微信公众号文章).
 *
 * URL shape: https://mp.weixin.qq.com/s/{id} or https://mp.weixin.qq.com/s/{id}?scene=...
 *
 * DOM strategy:
 *  - Title: `#activity-name` (h1.rich_media_title)
 *  - Author: `#js_author_name` or `.profile_nickname`
 *  - Body: `#js_content` (the article body container)
 *  - Images: WeChat lazy-loads images via `data-src`; rewrite to `src`
 *  - Strip noise: toolbar, share button, bottom QR code, related-article links
 */
export const wechatAdapter: ArticleAdapter = {
  name: 'wechat',
  description: 'WeChat Official Account articles (mp.weixin.qq.com)',
  match(url: string) {
    return /^https?:\/\/mp\.weixin\.qq\.com\/s\//i.test(url);
  },
  extract(_url: string, html: string, _pageUrl: string): AdapterResult {
    const $ = load(html);
    let title = '';
    let byline = '';

    // Title: prefer #activity-name, fall back to <h1> or <title>.
    const titleEl = $('#activity-name').first();
    if (titleEl.length && titleEl.text().trim()) {
      title = titleEl.text().trim();
    } else {
      title = $('h1').first().text().trim() || $('title').first().text().trim();
    }

    // Author: several candidates.
    const authorEl = $('#js_author_name, .profile_nickname, .rich_media_meta_text').first();
    if (authorEl.length && authorEl.text().trim()) {
      byline = authorEl.text().trim();
    }

    // Body: #js_content.
    const bodyEl = $('#js_content').first();
    if (!bodyEl.length) {
      // Some articles use different containers — try a few fallbacks.
      const alt = $('div.rich_media_content, div.weui-msg, article').first();
      if (!alt.length || $(alt).text().trim().length < 100) {
        return { html: undefined };
      }
      return {
        html: $(alt).html() ?? '',
        title: title || undefined,
        byline: byline || undefined,
        siteName: 'wechat'
      };
    }

    const bodyHtml = bodyEl.html() ?? '';

    // Post-process: lazy-load images + strip noise.
    const $body = load(bodyHtml);

    // Rewrite data-src → src for lazy-loaded images.
    for (const el of $body('img').toArray()) {
      const e = $(el);
      const src = e.attr('data-src') ?? e.attr('data-actualsrc');
      if (src) e.attr('src', src);
      // WeChat also uses tiny placeholder SVGs as the initial src — replace them.
      if (e.attr('src')?.includes('data:image/svg+xml')) {
        const real = src ?? e.attr('data-src');
        if (real) e.attr('src', real);
      }
    }

    // Strip noise: share buttons, toolbar, QR code, related links, "read more" prompts.
    $body('.js_pc_qr_code, .js_qr_code, .qr_code_pc, .qr_code_area, .ct_mpda_wrp, ' +
          '.rich_media_tool, .js_share_button, .js_pc_tool, .profile_container, ' +
          '.js_reward_area, .js_article_bottom_area, .js_pc_qr_code_area, .profile_group, ' +
          '.js_name, .js_verify_pc, .js_verify, .js_pc_verify').remove();

    // Remove empty anchors.
    for (const el of $body('a').toArray()) {
      const e = $(el);
      if (!e.text().trim() && !e.find('img').length) e.remove();
    }

    // Remove <script> tags (shouldn't be there, but safety).
    $body('script').remove();

    return {
      html: $body.root().html() ?? bodyHtml,
      title: title || undefined,
      byline: byline || undefined,
      siteName: 'wechat'
    };
  }
};
