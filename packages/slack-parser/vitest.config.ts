import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The parser is a pure `unknown -> ParsedSlackExport` function; no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
