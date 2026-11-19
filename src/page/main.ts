import { startFireside, type FiresideState } from '../engine/fireside'
import type { Relic } from '../world'
import { followHand, handForPage } from './cursor'
import { fullscreenButton, markTheNotch } from './phone'
import { storyLog } from './story'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const buttons = document.querySelectorAll<HTMLButtonElement>('[data-toggle]')
const params = new URLSearchParams(location.hash.slice(1))

const story = storyLog(document.getElementById('story')!)
const still = matchMedia('(prefers-reduced-motion: reduce)')
// whether the visitor has begun, and whether the story has (a moment after): sync() reads these, so
// they're declared before the first sync
let started = false
let storyOn = false

const pauseButton = document.querySelector<HTMLButtonElement>('[data-toggle=paused]')!
const soundGroup = document.querySelector<HTMLElement>('.sound')!
// the visitor's sound choice, remembered whenever it changes (the button, S, or the volume turning it on)
let soundWas: boolean | null = null
const sync = (s: FiresideState) => {
  if (soundWas !== null && s.sound !== soundWas) localStorage.setItem('fireside:sound', s.sound ? 'on' : 'off')
  soundWas = s.sound
  for (const b of buttons) b.setAttribute('aria-pressed', String(s[b.dataset.toggle as keyof FiresideState]))
  pauseButton.setAttribute('aria-label', s.paused ? 'Play' : 'Pause')
  pauseButton.title = s.paused ? 'Play (space)' : 'Pause (space)'
  soundGroup.dataset.on = String(s.sound)
  if (storyOn) story.hold(s.paused)
}

// Sound is on for visitors (it's half of why they come), but not in dev; a visitor who turns it off
// keeps it off. Browsers only let it play after a click or a key: it starts when they begin.
const soundWanted = !import.meta.env.DEV && localStorage.getItem('fireside:sound') !== 'off'

const forest = startFireside(canvas, {
  debug: params.has('debug'),
  rain: params.has('rain'),
  sound: soundWanted,
  paused: true, // until the visitor begins
  speed: Number(params.get('speed')) || 1,
  vigil: Number(params.get('vigil')) || undefined,
  relic: (params.get('relic') ?? undefined) as Relic | undefined,
  onStory: story.tell,
  onChange: sync,
})
sync(forest.state())
// A gentle start: the page waits on the dark until the scene's first frame is drawn and its pixel
// font is in, then fades up (page.css), still, with one way in over it (a click on it, or space or
// Enter anywhere).
const app = document.getElementById('app')!
const veil = document.getElementById('veil')!
// (it shows whatever happens: a font that fails to load still leaves the page readable)
void Promise.all([document.fonts.ready, new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))]).finally(() =>
  app.classList.add('ready'),
)
// Beginning starts the scene and, from that click or key, its sound; the story a moment after.
function begin() {
  if (started) return
  started = true
  veil.classList.add('gone')
  window.setTimeout(() => (veil.hidden = true), 900)
  if (forest.state().paused) forest.togglePause()
  window.setTimeout(
    () => {
      storyOn = true
      story.hold(forest.state().paused)
    },
    still.matches ? 0 : 700,
  )
}
veil.addEventListener('click', begin)
fullscreenButton(document.getElementById('fullscreen') as HTMLButtonElement)
markTheNotch()

// The hand is the cursor: pointing over the page, and over the clearing posed by what it's doing
// (open over something it could take, a fist while pressing or carrying wood, a torch's grip on a
// burning stick, a pinch for the lantern's ring or a shroomfolk's cap).
handForPage('point')
followHand(canvas, forest.handPose)
// the bars line up with the scene, whatever size it fits to
// (on the next frame: setting it inside the observer's own callback can resize what it observes)
new ResizeObserver(() => requestAnimationFrame(() => app.style.setProperty('--scene-w', `${canvas.getBoundingClientRect().width}px`))).observe(canvas)
if (params.has('debug')) Object.assign(window, { forest }) // poke at it from the console

// the volume, remembered between visits; moving it turns the sound on
const volume = document.getElementById('volume') as HTMLInputElement
const showVolume = () => volume.style.setProperty('--fill', `${Number(volume.value) * 100}%`)
// tap or drag anywhere along it (a finger needn't find the knob, and the page won't scroll)
const fromPointer = (e: PointerEvent) => {
  const box = volume.getBoundingClientRect()
  const u = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
  volume.value = String(Math.round(u * 20) / 20)
  volume.dispatchEvent(new Event('input'))
}
volume.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  volume.focus({ preventScroll: true })
  volume.setPointerCapture(e.pointerId)
  fromPointer(e)
})
volume.addEventListener('pointermove', (e) => volume.hasPointerCapture(e.pointerId) && fromPointer(e))
volume.value = localStorage.getItem('fireside:volume') ?? volume.value
forest.setVolume(Number(volume.value))
showVolume()
volume.addEventListener('input', () => {
  forest.setVolume(Number(volume.value))
  localStorage.setItem('fireside:volume', volume.value)
  showVolume()
  if (!forest.state().sound && Number(volume.value) > 0) forest.toggleSound()
})

const actions: Record<string, () => void> = {
  sound: forest.toggleSound,
  paused: () => (started ? forest.togglePause() : begin()), // before they begin, play is beginning
  rain: forest.toggleRain,
  glow: forest.toggleGlow,
  debug: forest.toggleDebug,
  normals: forest.toggleNormals,
}
for (const b of buttons) {
  b.addEventListener('click', () => {
    actions[b.dataset.toggle!]()
    b.blur()
  })
}

// S and space for everyone; the rendering switches only when debugging
const keys: Record<string, string> = { s: 'sound', ' ': 'paused' }
if (params.has('debug')) Object.assign(keys, { r: 'rain', g: 'glow', d: 'debug', n: 'normals' })
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (!started && e.key === 'Enter' && !(e.target instanceof HTMLAnchorElement)) return void begin()
  const action = keys[e.key.toLowerCase()]
  if (!action) return
  e.preventDefault()
  actions[action]()
})
