import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { staging } from './src/editor/staging-plugin.mjs'

/** The editor lives at /editor in the dev server only (the site's build is index.html alone). */
const editorRoute = (): Plugin => ({
  name: 'editor-route',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/editor' || req.url === '/editor/') req.url = '/editor.html'
      next()
    })
  },
})

export default defineConfig({
  plugins: [editorRoute(), staging({ root: fileURLToPath(new URL('.', import.meta.url)) })],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { main: fileURLToPath(new URL('index.html', import.meta.url)), embed: fileURLToPath(new URL('embed/index.html', import.meta.url)) },
    },
  },
})
