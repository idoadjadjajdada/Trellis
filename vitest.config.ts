import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // Tests share one database, so run files one after another.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
