import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // No "type": "module" in package.json, so `.js` is CommonJS and `.mjs` is ESM.
  // Pin extensions explicitly to match the exports map:
  // `import -> dist/index.mjs` / `require -> dist/index.js`.
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.js' };
  },
});
