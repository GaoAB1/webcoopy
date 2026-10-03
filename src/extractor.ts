import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { load } from 'cheerio';

export interface ExtractedArticle {
  title: string;
  content: string; // HTML
  byline: string;
  siteName: string;
  lang: string;
  dir: 'ltr' | 'rtl';
  excerpt: string;
  textContent: string;
  publishedTime: string;
}

/**
 * Preprocess HTML before handing to Readability.
 * Readability strips `class` attributes during its "clean" step,
 * so we snapshot code block languages onto `data-lang` (which is preserved).
 */
export function preprocessForExtraction(html: string): string {
  const $ = load(html);
  const langRegex = /\b(?:language|lang)-([a-z0-9+#-]+)/i;

  // Preserve code language on <code class="language-js">
  $('code[class]').each((_, el) => {
    const cls = $(el).attr('class') ?? '';
    const m = cls.match(langRegex);
    if (m && !$(el).attr('data-lang')) $(el).attr('data-lang', m[1]);
  });

  // Preserve language on <pre class="highlight-text-js"> (GitHub-style)
  const ghRegex = /highlight-(?:text|source)-([a-z0-9]+)/i;
  $('pre[class]').each((_, el) => {
    const cls = $(el).attr('class') ?? '';
    const m = cls.match(ghRegex);
    if (m && !$(el).attr('data-lang')) $(el).attr('data-lang', m[1]);
  });

  return $.root().html() ?? html;
}

/**
 * SPA loading / anti-bot placeholder messages. ByteDance sites (Juejin et al.)
 * intermittently serve a challenge or degraded shell whose only visible text
 * is a spinner message. Readability happily "extracts" that as the article,
 * which used to produce output files whose entire body was "Please wait...".
 * Matched against the whole whitespace-collapsed text content, so a real
 * article (which is never just one of these words) never trips the check.
 */
const LOADING_PLACEHOLDER_RE =
  /^(?:please\s+wait(?:\s*\.\.+)?|loading(?:\s*\.\.+)?|just\s+a\s+moment|checking\s+your\s+browser|verifying\s+your\s+browser|verify(?:ing)?\s+you\s+are\s+human|请稍候|加载中|正在加载|安全验证)[.…\s]*$/i;

/**
 * Extract the main article from a full HTML page using Mozilla Readability.
 * Returns null if the page does not appear to be an article (including when
 * the only extractable text is a loading/anti-bot placeholder — the pipeline
 * then reports `no-article` instead of writing a placeholder file).
 */
export function extractArticle(html: string): ExtractedArticle | null {
  const preprocessed = preprocessForExtraction(html);
  const dom = new JSDOM(preprocessed);
  const doc = dom.window.document;

  const article = new Readability(doc).parse();
  if (!article || !article.content) return null;

  const text = (article.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text || LOADING_PLACEHOLDER_RE.test(text)) return null;

  return {
    title: article.title ?? '',
    content: article.content,
    byline: article.byline ?? '',
    siteName: article.siteName ?? '',
    lang: article.lang ?? '',
    dir: (article.dir ?? 'ltr') as 'ltr' | 'rtl',
    excerpt: article.excerpt ?? '',
    textContent: article.textContent ?? '',
    publishedTime: article.publishedTime ?? ''
  };
}
