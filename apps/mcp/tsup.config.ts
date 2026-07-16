import { defineConfig } from 'tsup';

/**
 * Build config for the stdio MCP server (Phase 10 spec §2.1).
 *
 * Output is a single self-contained CommonJS executable at `dist/main.js`
 * (the `bin` target). The `@modelcontextprotocol/sdk` is ESM-only, so we bundle
 * it (and `zod` + the workspace packages) into the CJS output via `noExternal`
 * rather than leaving them as runtime `require()`s. Node built-ins stay external.
 *
 * The `banner` prepends the shebang so `node dist/main.js` (and the `bin`) runs
 * directly. `dts` is off — this is an executable, not a library.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  sourcemap: true,
  dts: false,
  // Bundle the ESM-only SDK, zod, and the workspace packages so the built
  // `dist/main.js` is a single self-contained CJS file.
  noExternal: [/@modelcontextprotocol\/sdk/, /^@family\//, 'zod'],
});
