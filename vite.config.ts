import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { staging } from './src/editor/staging-plugin.mjs'

/** Where a path in the repo is. */
const repo = (path: string) => fileURLToPath(new URL(path, import.meta.url))

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
  plugins: [staging({ root: repo('.') }), editorRedirect()],
  // the pages name the code as /src/…: it's the repo's src/, beside pages/ (not inside it)
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
