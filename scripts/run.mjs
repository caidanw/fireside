// Run a TypeScript script against the game's own modules: bundle it for Node with Rolldown (Vite's
// bundler, so nothing extra to install) and run it, passing on its arguments.
//   node scripts/run.mjs scripts/smoke.ts [args]
import { rolldown } from 'rolldown'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [entry, ...args] = process.argv.slice(2)
if (!entry) throw new Error('usage: node scripts/run.mjs <script.ts> [args]')
const dir = mkdtempSync(join(tmpdir(), 'fireside-'))
const file = join(dir, 'script.mjs')
const bundle = await rolldown({ input: resolve(entry), platform: 'node', logLevel: 'warn' })
await bundle.write({ file, format: 'esm', codeSplitting: false })
process.argv = [process.argv[0], file, ...args]
try {
  await import(pathToFileURL(file).href)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
