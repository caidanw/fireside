/**
 * The editor's page (the dev server's /editor; never built for the site): its chrome round a
 * smaller live scene. The same URL options as the game (#rain, #speed=4, #relic=key, …).
 */
import { startDarkForest } from '../index'
import type { Relic } from '../world'
import { mountEditor } from './index'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const params = new URLSearchParams(location.hash.slice(1))
const editor = mountEditor()
editor.stage.append(canvas)

const forest = startDarkForest(canvas, {
  debug: params.has('debug'),
  rain: params.has('rain'),
  speed: Number(params.get('speed')) || 1,
  vigil: Number(params.get('vigil')) || undefined,
  relic: (params.get('relic') ?? undefined) as Relic | undefined,
  onStory: (line) => editor.story(line),
  onChange: () => editor.refresh(),
  onInspect: () => editor.refresh(),
})
editor.attach(forest)
forest.setVolume(Number(localStorage.getItem('fireside:volume') ?? 0.7))
Object.assign(window, { forest }) // poke at it from the console

// S and space, and the rendering switches
const actions: Record<string, () => void> = {
  s: forest.toggleSound,
  ' ': forest.togglePause,
  r: forest.toggleRain,
  g: forest.toggleGlow,
  d: forest.toggleDebug,
  n: forest.toggleNormals,
}
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
  const action = actions[e.key.toLowerCase()]
  if (!action) return
  e.preventDefault()
  action()
})
