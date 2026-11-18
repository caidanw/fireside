import { startDarkForest, type DarkForestState } from './index'
import type { Relic } from './world'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const buttons = document.querySelectorAll<HTMLButtonElement>('[data-toggle]')
const params = new URLSearchParams(location.hash.slice(1))

// the village's story: the newest line arrives at the top of the log and pushes the older ones
// down, where the last two fade away. Each line is spelled out a letter at a time; lines that
// arrive together wait their turn, so the typing itself sets the pace.
const story = document.getElementById('story')!
const storyQueue: string[] = []
const still = matchMedia('(prefers-reduced-motion: reduce)')
let telling = false
// the scene appears first (see reveal, below), then the story begins
let begun = false
function tellStory(line: string) {
  storyQueue.push(line)
  if (begun && !telling) showNext()
}
function showNext() {
  const line = storyQueue.shift()
  telling = line !== undefined
  if (line === undefined) return
  // lines pushed past the bottom (through the fade) are gone
  for (const old of [...story.children] as HTMLElement[]) if (old.offsetTop >= story.clientHeight) old.remove()
  // the whole line is laid out from the start (the untyped part invisible), so words don't jump
  // between rows as it types; screen readers get the line once, whole
  const item = document.createElement('li')
  const heard = Object.assign(document.createElement('span'), { className: 'heard', textContent: line })
  const typed = document.createElement('span')
  const rest = Object.assign(document.createElement('span'), { className: 'rest', textContent: line })
  typed.ariaHidden = rest.ariaHidden = 'true'
  item.append(heard, typed, rest)
  story.prepend(item)
  requestAnimationFrame(() => requestAnimationFrame(() => item.classList.add('shown')))
  let i = still.matches ? line.length : 0
  const type = () => {
    typed.textContent = line.slice(0, i)
    rest.textContent = line.slice(i)
    if (i >= line.length) return void window.setTimeout(showNext, 900)
    const c = line[i++]
    window.setTimeout(type, 32 + (c === ',' ? 160 : c === '.' && i < line.length ? 320 : 0))
  }
  type()
}

const pauseButton = document.querySelector<HTMLButtonElement>('[data-toggle=paused]')!
const soundGroup = document.querySelector<HTMLElement>('.sound')!
// the visitor's sound choice, remembered whenever it changes (the button, S, or the volume turning it on)
let soundWas: boolean | null = null
const sync = (s: DarkForestState) => {
  if (soundWas !== null && s.sound !== soundWas) localStorage.setItem('fireside:sound', s.sound ? 'on' : 'off')
  soundWas = s.sound
  for (const b of buttons) b.setAttribute('aria-pressed', String(s[b.dataset.toggle as keyof DarkForestState]))
  pauseButton.setAttribute('aria-label', s.paused ? 'Play' : 'Pause')
  pauseButton.title = s.paused ? 'Play (space)' : 'Pause (space)'
  soundGroup.dataset.on = String(s.sound)
}

// Sound is on for visitors (it's half of why they come), but not in dev; a visitor who turns it off
// keeps it off. Browsers only let it play after a click, tap or key, so it begins with the first one.
const soundWanted = !import.meta.env.DEV && localStorage.getItem('fireside:sound') !== 'off'

const forest = startDarkForest(canvas, {
  debug: params.has('debug'),
  rain: params.has('rain'),
  sound: soundWanted,
  speed: Number(params.get('speed')) || 1,
  vigil: Number(params.get('vigil')) || undefined,
  relic: (params.get('relic') ?? undefined) as Relic | undefined,
  onStory: tellStory,
  onChange: sync,
})
sync(forest.state())
// A gentle start: the page waits on the dark until the scene's first frame is drawn and its pixel
// font is in, then fades up (page.css); the story begins a moment after.
const app = document.getElementById('app')!
Promise.all([document.fonts.ready, new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))]).then(() => {
  app.classList.add('ready')
  window.setTimeout(
    () => {
      begun = true
      if (!telling) showNext()
    },
    still.matches ? 300 : 1400,
  )
})
// the bars line up with the scene, whatever size it fits to
new ResizeObserver(() => document.getElementById('app')!.style.setProperty('--scene-w', `${canvas.getBoundingClientRect().width}px`)).observe(canvas)
if (params.has('debug')) Object.assign(window, { forest }) // poke at it from the console

// the first click, tap or key anywhere starts the sound, if it's on (but not a click on the sound
// button itself: that one is turning it off)
const wake = (e: Event) => {
  if (e.target instanceof Element && e.target.closest('[data-toggle=sound]')) return
  forest.resumeSound()
}
for (const type of ['pointerdown', 'keydown', 'touchend']) addEventListener(type, wake, { capture: true, passive: true })

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
  paused: forest.togglePause,
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
  const action = keys[e.key.toLowerCase()]
  if (!action) return
  e.preventDefault()
  actions[action]()
})
