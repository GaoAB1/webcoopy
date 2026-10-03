export interface ArticleMeta {
  title: string;
  author?: string;
  source: string;
  fetchedAt: Date;
  siteName?: string;
}

/**
 * Escape a scalar value for use inside a YAML double-quoted string.
 * Handles backslashes and double quotes; newlines are left as-is (rare in our fields).
 */
function yamlString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Build a YAML front-matter block for the article.
 */
export function buildFrontMatter(meta: ArticleMeta): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${yamlString(meta.title)}`);
  if (meta.author) lines.push(`author: ${yamlString(meta.author)}`);
  if (meta.siteName) lines.push(`site: ${yamlString(meta.siteName)}`);
  lines.push(`source: ${yamlString(meta.source)}`);
  lines.push(`fetched_at: ${yamlString(meta.fetchedAt.toISOString())}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * Combine front-matter and body content.
 */
export function renderDocument(frontMatter: string, body: string): string {
  return `${frontMatter}\n\n${body.replace(/^\n+/, '')}\n`;
}
