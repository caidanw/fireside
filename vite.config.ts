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

/**
 * /x/ is the link to post on X: the site's own page, but carrying a player card instead of an image
 * card, so X plays the scene (/embed/) inside the post. Written from the built index.html, so it's
 * always the same page; the home page keeps its image card for everywhere else (one card per page).
 * See docs/research/x-player-card.md.
 */
const SITE = 'https://fireside.caidan.dev'
const xSharePage = (): Plugin => ({
  name: 'x-share-page',
  apply: 'build',
  enforce: 'post', // after Vite has written the pages
  generateBundle(_options, bundle) {
    const index = bundle['index.html']
    if (index?.type !== 'asset') return
    const html = String(index.source)
    const card = '<meta name="twitter:card" content="summary_large_image" />'
    if (!html.includes(card)) this.error('index.html has no summary_large_image card to swap for the player')
    const player = [
      '<meta name="twitter:card" content="player" />',
      `<meta name="twitter:player" content="${SITE}/embed/" />`,
      '<meta name="twitter:player:width" content="640" />',
      '<meta name="twitter:player:height" content="360" />',
      `<meta name="twitter:image" content="${SITE}/card-player.png" />`,
      '<meta name="robots" content="noindex" />',
    ].join('\n    ')
    this.emitFile({ type: 'asset', fileName: 'x/index.html', source: html.replace(card, player) })
  },
})

export default defineConfig({
  plugins: [editorRoute(), staging({ root: fileURLToPath(new URL('.', import.meta.url)) }), xSharePage()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { main: fileURLToPath(new URL('index.html', import.meta.url)), embed: fileURLToPath(new URL('embed/index.html', import.meta.url)) },
    },
  },
})
