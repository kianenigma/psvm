import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths, so the site works under the GitHub Pages sub-path.
  base: './',
  test: {
    environment: 'node',
    testTimeout: 120_000,
  },
});
