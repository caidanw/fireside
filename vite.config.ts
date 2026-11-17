import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { forestStaging } from './src/editor/staging-plugin.mjs'

// The editor (#edit on localhost) saves through staging: dev server only (see src/editor/staging-plugin.mjs).
export default defineConfig({
  plugins: [forestStaging({ root: fileURLToPath(new URL('.', import.meta.url)) })],
  build: { target: 'es2022' },
})
