/**
 * Adapter result: either raw markdown (already final form) or HTML
 * that was pre-processed for the converter.
 */
export interface AdapterResult {
  /** Optional title; falls back to converter extraction if absent. */
  title?: string;
  /**
   * If provided, this is the raw markdown output — bypass the converter entirely.
   * If omitted, `html` is passed to turndown like a normal page.
   */
  markdown?: string;
  /** HTML body to hand off to the converter. */
  html?: string;
  /** Optional author/byline. */
  byline?: string;
  /** Optional site name override. */
  siteName?: string;
  /**
   * Extraction found nothing usable AND the page looks like a bot-degraded
   * response (missing SSR payload / challenge shell). The pipeline refetches
   * once with full browser headers (`browserMode`) and runs the adapter again
   * before falling back to Readability.
   */
  retryWithBrowser?: boolean;
}

/**
 * A platform adapter knows how to extract content from a specific site.
 * Adapters take precedence over Mozilla Readability when they match.
 */
export interface ArticleAdapter {
  /** Stable identifier (e.g. 'github-readme'). */
  name: string;
  /** Human-readable label. */
  description: string;
  /** Decide if this adapter should handle the URL. */
  match(url: string): boolean;
  /**
   * Optional. Return a different URL to fetch from instead of the original.
   * Useful when the site serves content from a separate endpoint (e.g. GitHub README → raw.githubusercontent.com).
   */
  resolveFetchUrl?(url: string): string | null;
  /**
   * Extract content. `html` is the body fetched from either the resolved URL or the original.
   */
  extract(url: string, html: string, pageUrl: string): Promise<AdapterResult> | AdapterResult;
}

/**
 * Registry for article adapters. Multiple adapters can match the same URL;
 * they are tried in registration order and the first to return usable content wins.
 */
export class AdapterRegistry {
  private adapters: ArticleAdapter[] = [];

  register(adapter: ArticleAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  registerAll(adapters: ArticleAdapter[]): this {
    for (const a of adapters) this.register(a);
    return this;
  }

  /** Return adapters that match the given URL, in registration order. */
  findFor(url: string): ArticleAdapter[] {
    const u = url.toLowerCase();
    return this.adapters.filter((a) => {
      try {
        return a.match(u);
      } catch {
        return false;
      }
    });
  }

  count(): number {
    return this.adapters.length;
  }

  list(): ArticleAdapter[] {
    return [...this.adapters];
  }
}
