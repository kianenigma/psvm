import { defineConfig } from 'vitest/config';

/**
 * Content-Security-Policy of the built site: scripts only from the site itself, network only to the site, the GitHub
 * API and raw files, fonts only from Google Fonts. Build-only, since the dev server needs inline styles and a
 * websocket for hot reload.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self' https://api.github.com https://raw.githubusercontent.com",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  // Relative asset paths, so the site works under the GitHub Pages sub-path.
  base: './',
  plugins: [
    {
      name: 'csp',
      apply: 'build',
      transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
    },
  ],
  test: {
    environment: 'node',
    testTimeout: 120_000,
  },
});
