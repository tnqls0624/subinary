import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Chunking / fusion / vector helpers are pure functions; no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
