import type TurndownService from 'turndown';

type Node = HTMLElement;

/**
 * Turndown custom rule for <a>:
 *   - Preserve #anchor links as-is (don't absolutize).
 *   - Skip empty href.
 *   - Default passthrough for other links.
 */
export function addLinkRule(service: TurndownService): void {
  service.addRule('anchorLink', {
    filter: (node) => node.nodeName === 'A',
    replacement: (content, node) => {
      const a = node as Node;
      const href = a.getAttribute('href');

      if (!href) return content;
      if (href === '#') return content;

      // Anchor-only links stay as-is.
      if (href.startsWith('#')) {
        return `[${content}](${href})`;
      }

      return `[${content}](${href})`;
    }
  });
}
