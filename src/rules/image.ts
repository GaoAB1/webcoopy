import type TurndownService from 'turndown';

type Node = HTMLElement;

/**
 * Turndown custom rule for <img> that always emits ![alt](src).
 * Skips images with empty src (spacer GIFs, icon fonts, etc.).
 *
 * Note: URL absolutization is done upstream by preprocessing — this rule
 * only controls the output shape.
 */
export function addImageRule(service: TurndownService): void {
  service.addRule('imageClean', {
    filter: (node) => node.nodeName === 'IMG',
    replacement: (_content, node) => {
      const img = node as Node;
      const src = img.getAttribute('src');
      if (!src) return '';

      const alt = (img.getAttribute('alt') ?? '').trim();
      return `![${alt}](${src})`;
    }
  });
}
