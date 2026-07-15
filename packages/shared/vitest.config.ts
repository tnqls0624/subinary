import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Categorization is pure string -> slug logic; no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
