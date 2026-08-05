import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* package.json sets "type": "module", so there is no __dirname to resolve
   against. This is the ESM equivalent, and it is what every path below is
   relative to. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/*
 * The website, built separately from the application.
 *
 * The repository root already has a vite.config.ts — that one builds the
 * Electron renderer. This is a second, unrelated Vite project with its own
 * dependencies, kept in its own directory so the two never share a config,
 * a node_modules or a build output.
 *
 * `outDir` is ../docs because that is the directory GitHub Pages publishes.
 * Everything in there is generated: see scripts/sync-site-version.js for how
 * a release reaches the download buttons now that the page is built rather
 * than hand-edited.
 */
export default defineConfig({
  plugins: [react()],

  /*
   * Relative asset URLs.
   *
   * The site is served from https://vijayaapardhu.dev/Clipboard/ — a
   * subdirectory, not a domain root. Absolute paths like /assets/main.js
   * would resolve to the domain root and 404. Relative ones work at both,
   * which also means the built output opens correctly straight off the
   * filesystem when checking it.
   */
  base: './',

  build: {
    outDir: here('../docs'),
    emptyOutDir: true,
    assetsDir: 'assets',

    /*
     * Four pages, not one.
     *
     * The legal and changelog pages are prose. Routing to them client-side
     * would mean shipping a router, and on static hosting a deep link to one
     * would 404 before any of it ran. As real HTML files they are reachable,
     * indexable and readable with JavaScript switched off entirely.
     */
    rollupOptions: {
      /*
       * `build/index.html` rather than `build.html`.
       *
       * Static hosting has no rewrite rules, so /build would simply 404
       * against a file called build.html. A directory with an index in it is
       * how you get an extensionless URL out of GitHub Pages — it serves
       * /build/ and redirects /build to it.
       *
       * The cost is that page sits one level down, so anything it links to
       * at the site root needs `../`. See the `prefix` prop on Footer.
       */
      input: {
        main: here('index.html'),
        build: here('build/index.html'),
        changelog: here('changelog.html'),
        privacy: here('privacy.html'),
        terms: here('terms.html')
      }
    },

    /*
     * Three.js is most of the JavaScript on the page and none of it is needed
     * to read the words. Splitting it out lets the document, the styles and
     * the rest of the bundle arrive first, with the shader following.
     */
    chunkSizeWarningLimit: 900
  }
});
