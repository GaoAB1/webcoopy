import type TurndownService from 'turndown';

type Node = HTMLElement;

/**
 * Extract code block language from a <pre> or <code> element.
 * Recognizes common conventions:
 *   - <code class="language-js"> … </code>
 *   - <code class="lang-js"> … </code>
 *   - <code data-lang="js"> … </code>
 *   - <pre class="highlight-text-js"> … </pre>
 *   - <pre><code class="language-js"> … </code></pre>
 */
export function extractCodeLanguage(node: Node): string {
  // Directly on a <code> element.
  if (node.nodeName === 'CODE') {
    const cls = (node.getAttribute('class') ?? '').toLowerCase();
    const langMatch = cls.match(/\b(?:language|lang)-([a-z0-9+#-]+)/i);
    if (langMatch) return langMatch[1];
    return node.getAttribute('data-lang')?.trim() ?? '';
  }

  // <pre class="highlight-text-js"> (GitHub) or similar
  const cls = (node.getAttribute('class') ?? '').toLowerCase();
  const ghMatch = cls.match(/highlight-(?:text|source)-([a-z0-9]+)/i);
  if (ghMatch) return ghMatch[1];

  // data-lang on <pre>
  const dataLang = node.getAttribute('data-lang')?.trim();
  if (dataLang) return dataLang;

  // Walk into first <code> child if present.
  const firstChild = node.firstChild;
  if (firstChild && typeof firstChild === 'object' && 'nodeName' in firstChild) {
    const child = firstChild as Node;
    if (child.nodeName === 'CODE') return extractCodeLanguage(child);
  }

  return '';
}

/**
 * Turndown custom rule that preserves code block language on <pre> elements.
 */
export function addCodeBlockRule(service: TurndownService): void {
  service.addRule('codeBlockLanguage', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node, options) => {
      const pre = node as Node;
      const lang = extractCodeLanguage(pre);

      // Prefer textContent of <pre> to preserve whitespace/newlines.
      const text =
        typeof pre.textContent === 'string' ? pre.textContent : '';

      const fence = options.fence ?? '```';
      return `\n\n${fence}${lang}\n${text.replace(/\n$/, '')}\n${fence}\n\n`;
    }
  });
}
