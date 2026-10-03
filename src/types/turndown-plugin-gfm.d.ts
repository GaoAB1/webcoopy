// Type shim for turndown-plugin-gfm (no official .d.ts shipped).
// The CJS module exports each rule as a top-level function.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  type Rule = (service: TurndownService) => void;

  export const tables: Rule;
  export const strikethrough: Rule;
  export const taskListItems: Rule;
  export const highlightedCodeBlock: Rule;
  /** Convenience preset: applies highlightedCodeBlock, strikethrough, tables, taskListItems. */
  export const gfm: Rule;
}
