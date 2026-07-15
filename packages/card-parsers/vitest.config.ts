import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Parsers are pure string -> result functions; no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
