import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { staging } from './src/editor/staging-plugin.mjs'

/** Where a path in the repo is. */
const repo = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * The pages' pixel icons are files (pages/icons/*.svg). A page names one with a placeholder,
 * <svg data-icon="sound-on" class="icon on"></svg>, and gets the icon inline in its place (so it
 * takes the page's colours), with the placeholder's class.
 */
const icons = (): Plugin => ({
  name: 'icons',
  transformIndexHtml: (html) =>
    html.replace(/<svg data-icon="([\w-]+)"((?: class="[^"]*")?)><\/svg>/g, (_, name: string, cls: string) =>
      readFileSync(repo(`pages/icons/${name}.svg`), 'utf8')
        .trim()
        .replace(/^<svg xmlns="[^"]*"/, `<svg${cls} aria-hidden="true"`),
    ),
})

/** /editor (as it was before it had a folder) goes to /editor/, in the dev server. */
const editorRedirect = (): Plugin => ({
  name: 'editor-redirect',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/editor') return next()
      res.writeHead(301, { Location: '/editor/' }).end()
    })
  },
})

/**
 * The pages are in pages/: the site (index.html), the scene alone for X's player card (embed/), and
 * the editor (editor/, the dev server's only: the build leaves it out).
 */
export default defineConfig({
  root: repo('pages'),
  publicDir: repo('public'),
  plugins: [icons(), staging({ root: repo('.') }), editorRedirect()],
  // the pages name their code /src/…: it's the repo's src/, beside pages/ (not inside it)
  resolve: { alias: [{ find: /^\/src\//, replacement: `${repo('src')}/` }] },
  build: {
    target: 'es2022',
    outDir: repo('dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: { main: repo('pages/index.html'), embed: repo('pages/embed/index.html') },
    },
  },
})
