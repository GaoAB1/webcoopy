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
 * Extract the main article from a full HTML page using Mozilla Readability.
 * Returns null if the page does not appear to be an article.
 */
export function extractArticle(html: string): ExtractedArticle | null {
  const preprocessed = preprocessForExtraction(html);
  const dom = new JSDOM(preprocessed);
  const doc = dom.window.document;

  const article = new Readability(doc).parse();
  if (!article || !article.content) return null;

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
