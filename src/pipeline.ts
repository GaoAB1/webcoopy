import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchHtml, FetchError, type FetcherOptions, type FetchErrorCode } from './fetcher.js';
import { extractArticle } from './extractor.js';
import { htmlToMarkdown } from './converter.js';
import { buildFrontMatter, renderDocument, type ArticleMeta } from './meta.js';
import { slugify, writeMarkdown, type WriteResult } from './fs.js';
import { localizeImages, type ImageLocalizerOptions } from './images.js';
import { AdapterRegistry, type ArticleAdapter } from './adapters.js';
import { githubReadmeAdapter } from './adapters/github-readme.js';
import { zhihuAdapter } from './adapters/zhihu.js';
import { wechatAdapter } from './adapters/wechat.js';
import { juejinAdapter } from './adapters/juejin.js';

export interface PipelineOptions {
  outDir: string;
  overwrite: boolean;
  fetch?: FetcherOptions;
  verbose?: boolean;
  /**
   * Disable platform adapters. When true, all URLs go through Readability.
   * Default: false (adapters enabled).
   */
  disableAdapters?: boolean;
  /** Override the adapter registry (for testing or custom adapters). */
  adapters?: AdapterRegistry;
  /**
   * Localize remote images to `<outDir>/<slug>/images/` before writing.
   * Failed downloads keep the original URL so the article degrades gracefully.
   * Default: false (remote URLs preserved).
   */
  localizeImages?: boolean;
  /** Extra options for the image localizer (e.g. maxBytes, timeoutMs). */
  imageOptions?: Partial<Omit<ImageLocalizerOptions, 'outDir' | 'slug' | 'fetcher'>>;
}

export type PipelineErrorCode =
  | FetchErrorCode
  | 'no-article'
  | 'filesystem';

export interface ImageStats {
  local: number;
  failed: number;
  skipped: number;
}

export interface PipelineResult {
  ok: boolean;
  url: string;
  slug: string;
  path?: string;
  skipped?: boolean;
  title?: string;
  error?: string;
  errorCode?: PipelineErrorCode;
  /** Name of the adapter used, if any. */
  adapter?: string;
  /** Present only when `localizeImages` was enabled and there were images. */
  images?: ImageStats;
}

export const defaultAdapters = (): AdapterRegistry =>
  new AdapterRegistry().registerAll([githubReadmeAdapter, zhihuAdapter, wechatAdapter, juejinAdapter]);

/**
 * Fetch a URL, extract the article body, convert to Markdown, and write it to disk.
 */
export async function processUrl(url: string, options: PipelineOptions): Promise<PipelineResult> {
  const log = options.verbose ? (msg: string) => console.log(`[webcopy] ${msg}`) : () => {};
  const slug = slugify(urlSafeSlug(url));
  const registry = options.disableAdapters ? new AdapterRegistry() : (options.adapters ?? defaultAdapters());

  try {
    // 1. Check adapters first — some adapters need a different URL to fetch.
    const matched = registry.findFor(url);
    let fetchUrl = url;
    let primaryAdapter: ArticleAdapter | undefined;
    if (matched.length > 0) {
      primaryAdapter = matched[0];
      const overrideUrl = primaryAdapter.resolveFetchUrl?.(url);
      if (overrideUrl) {
        fetchUrl = overrideUrl;
        log(`adapter [${primaryAdapter.name}] resolving to ${fetchUrl}`);
      }
    }

    log(`fetching ${fetchUrl}`);
    const { html, url: finalUrl, charset } = await fetchHtml(fetchUrl, options.fetch);
    if (options.verbose && charset !== 'utf-8') log(`charset: ${charset}`);

    // 2. Try adapter extraction if an adapter matched.
    if (primaryAdapter) {
      log(`extracting via adapter [${primaryAdapter.name}]…`);
      const result = await primaryAdapter.extract(url, html, finalUrl);
      if (result.markdown !== undefined || result.html !== undefined) {
        const body = result.markdown ?? htmlToMarkdown(result.html ?? html, { pageUrl: finalUrl });
        const meta: ArticleMeta = {
          title: result.title || slug,
          author: result.byline || undefined,
          siteName: result.siteName || undefined,
          source: url, // keep original URL, not the raw endpoint
          fetchedAt: new Date()
        };
        const { writeResult, images } = await finalizeAndWrite({
          body,
          meta,
          slug,
          options,
          log
        });
        return {
          ok: true,
          url,
          slug,
          path: writeResult.path,
          skipped: writeResult.skipped,
          title: result.title,
          adapter: primaryAdapter.name,
          images
        };
      }
      log(`adapter [${primaryAdapter.name}] returned no content, falling back to Readability`);
    }

    // 3. Fallback: Readability + turndown.
    log('extracting article…');
    const article = extractArticle(html);
    if (!article) {
      return {
        ok: false,
        url,
        slug,
        error: 'No readable article detected in the page (may be a non-article, search, or anti-bot page).',
        errorCode: 'no-article'
      };
    }

    log('converting to markdown…');
    const body = htmlToMarkdown(article.content, { pageUrl: finalUrl });
    const meta: ArticleMeta = {
      title: article.title || slug,
      author: article.byline || undefined,
      siteName: article.siteName || undefined,
      source: finalUrl,
      fetchedAt: new Date()
    };
    const { writeResult, images } = await finalizeAndWrite({
      body,
      meta,
      slug,
      options,
      log
    });

    return {
      ok: true,
      url: finalUrl,
      slug,
      path: writeResult.path,
      skipped: writeResult.skipped,
      title: article.title,
      images
    };
  } catch (err) {
    if (err instanceof FetchError) {
      return { ok: false, url, slug, error: err.message, errorCode: err.code };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, url, slug, error: message, errorCode: 'filesystem' };
  }
}

interface FinalizeArgs {
  body: string;
  meta: ArticleMeta;
  slug: string;
  options: PipelineOptions;
  log: (msg: string) => void;
}

interface FinalizeResult {
  writeResult: WriteResult;
  images?: ImageStats;
}

/**
 * Shared write-phase: optionally localize images, build the front-matter + body
 * document, and write to disk. Localizes only when we know the file will actually
 * be written (avoids leaving orphan images behind on `skipped` writes).
 */
async function finalizeAndWrite(args: FinalizeArgs): Promise<FinalizeResult> {
  const { body, meta, slug, options, log } = args;

  let images: ImageStats | undefined;
  let bodyFinal = body;

  const targetPath = join(options.outDir, `${slug}.md`);
  let willSkip = false;
  if (!options.overwrite) {
    try {
      await access(targetPath);
      willSkip = true;
    } catch {
      // File doesn't exist — we'll write it.
    }
  }

  if (!willSkip && options.localizeImages) {
    log('localizing images…');
    const r = await localizeImages(body, {
      outDir: options.outDir,
      slug,
      ...(options.imageOptions ?? {})
    });
    bodyFinal = r.markdown;
    images = { local: r.local, failed: r.failed, skipped: r.skipped };
    if (options.verbose && (r.local + r.failed + r.skipped > 0)) {
      log(`images: ${r.local} local, ${r.failed} failed, ${r.skipped} skipped`);
    }
  }

  const frontMatter = buildFrontMatter(meta);
  const doc = renderDocument(frontMatter, bodyFinal);
  const writeResult = await writeMarkdown(doc, slug, {
    outDir: options.outDir,
    overwrite: options.overwrite
  });

  return { writeResult, images };
}

/**
 * Run pipeline for multiple URLs sequentially.
 */
export async function processMany(
  urls: string[],
  options: PipelineOptions
): Promise<PipelineResult[]> {
  const results: PipelineResult[] = [];
  for (const url of urls) {
    results.push(await processUrl(url, options));
  }
  return results;
}

/**
 * Cheap, side-effect-free URL→slug used when the article title is unknown yet.
 * Kept here so pipeline results have a stable slug even on failure.
 */
function urlSafeSlug(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] ?? u.hostname;
    return last;
  } catch {
    return url.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').toLowerCase();
  }
}
