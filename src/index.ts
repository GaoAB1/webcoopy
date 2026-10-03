#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from './cli.js';

// Re-export public API for library consumers.
export * from './pipeline.js';
export * from './fetcher.js';
export * from './extractor.js';
export * from './converter.js';
export * from './images.js';
export * from './meta.js';
export * from './fs.js';
export * from './cli.js';
export * from './web.js';
export * from './rules/code-block.js';
export * from './rules/image.js';
export * from './rules/link.js';

// When run directly (not imported), execute the CLI.
if (process.argv[1]) {
  const invoked = pathToFileURL(process.argv[1]).href;
  if (invoked === import.meta.url) {
    main().catch((err) => {
      console.error('webcopy crashed:', err);
      process.exit(1);
    });
  }
}
