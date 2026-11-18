import { startDarkForest, type DarkForestState } from './index'
import type { Relic } from './world'
import { handForPage, useHand } from './cursor'

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
// The story keeps the scene's time: before the visitor begins, and whenever they pause, its typing
// holds (mid-line if need be) and carries on from the same letter.
let held = true
// whether the visitor has begun, and whether the story has (a moment after): sync() reads these, so
// they're declared before the first sync
let started = false
let storyOn = false
const waiting: (() => void)[] = []
const later = (ms: number, fn: () => void) => window.setTimeout(() => (held ? waiting.push(fn) : fn()), ms)
function hold(h: boolean) {
  held = h
  if (h) return
  for (const fn of waiting.splice(0)) fn()
  if (!telling) showNext()
}
function tellStory(line: string) {
  storyQueue.push(line)
  if (!held && !telling) showNext()
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
    if (i >= line.length) return void later(900, showNext)
    const c = line[i++]
    later(32 + (c === ',' ? 160 : c === '.' && i < line.length ? 320 : 0), type)
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
  if (storyOn) hold(s.paused)
}

// Sound is on for visitors (it's half of why they come), but not in dev; a visitor who turns it off
// keeps it off. Browsers only let it play after a click or a key: it starts when they begin.
const soundWanted = !import.meta.env.DEV && localStorage.getItem('fireside:sound') !== 'off'

const forest = startDarkForest(canvas, {
  debug: params.has('debug'),
  rain: params.has('rain'),
  sound: soundWanted,
  paused: true, // until the visitor begins
  speed: Number(params.get('speed')) || 1,
  vigil: Number(params.get('vigil')) || undefined,
  relic: (params.get('relic') ?? undefined) as Relic | undefined,
  onStory: tellStory,
  onChange: sync,
})
sync(forest.state())
// A gentle start: the page waits on the dark until the scene's first frame is drawn and its pixel
// font is in, then fades up (page.css), still, with one way in over it (a click on it, or space or
// Enter anywhere).
const app = document.getElementById('app')!
const veil = document.getElementById('veil')!
Promise.all([document.fonts.ready, new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))]).then(() => {
  app.classList.add('ready')
})
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
      hold(forest.state().paused)
    },
    still.matches ? 0 : 700,
  )
}
veil.addEventListener('click', begin)
// On a phone or tablet, a way to give the clearing the whole screen (where the browser allows it:
// not iPhone Safari, which keeps fullscreen for video). Landscape suits it, if the phone will turn.
const fullscreen = document.getElementById('fullscreen') as HTMLButtonElement
fullscreen.hidden = !(matchMedia('(pointer: coarse)').matches && document.fullscreenEnabled)
fullscreen.addEventListener('click', async () => {
  if (document.fullscreenElement) return void document.exitFullscreen()
  await document.documentElement.requestFullscreen()
  const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
  await orientation.lock?.('landscape').catch(() => {})
})
document.addEventListener('fullscreenchange', () => fullscreen.setAttribute('aria-pressed', String(!!document.fullscreenElement)))

// Which side the notch is on, held sideways: iOS pads both sides of the page alike, so the CSS can't
// tell, but the turn can (90: turned anticlockwise, the top of the phone and its notch on the left).
// page.css puts the scene on that side, under the notch, and the story on the other.
const markNotch = () => {
  const turned = (window as Window & { orientation?: number }).orientation
  const side = turned === 90 ? 'left' : turned === -90 ? 'right' : undefined
  if (document.documentElement.dataset.notch === side) return
  if (side) document.documentElement.dataset.notch = side
  else delete document.documentElement.dataset.notch
}
// Turning from one side to the other doesn't resize the page, and iOS may only update the turn after
// its events have fired: so check on every sign of a turn, again a moment later, and once a second
// besides (one number read)
const onTurn = () => {
  markNotch()
  setTimeout(markNotch, 250)
  setTimeout(markNotch, 800)
}
markNotch()
addEventListener('orientationchange', onTurn)
addEventListener('resize', onTurn)
screen.orientation?.addEventListener('change', onTurn)
setInterval(markNotch, 1000)

// #turn: what the page knows about the phone's turn, shown live (to find out what a phone reports)
if (params.has('turn')) {
  const readout = Object.assign(document.createElement('pre'), { className: 'turn-readout' })
  readout.style.cssText =
    'position:fixed;z-index:9;left:50%;top:50%;translate:-50% -50%;margin:0;padding:8px 10px;background:#000c;color:#ffcf8e;font:13px/1.4 monospace;pointer-events:none'
  document.body.append(readout)
  const show = () => {
    const o = screen.orientation
    readout.textContent = [
      `window.orientation  ${String((window as Window & { orientation?: number }).orientation)}`,
      `screen.orientation  ${o ? `${o.type} ${o.angle}` : 'none'}`,
      `data-notch          ${document.documentElement.dataset.notch ?? 'none'}`,
      `size                ${innerWidth}x${innerHeight}`,
    ].join('\n')
    requestAnimationFrame(show)
  }
  show()
}

// The hand is the cursor: pointing over the page, and over the clearing posed by what it's doing
// (open over something it could take, a fist while pressing or carrying wood, a torch's grip on a
// burning stick, a pinch for the lantern's ring or a shroomfolk's cap).
handForPage('point')
let pose = ''
const showPose = () => {
  const next = forest.handPose()
  if (next !== pose) useHand(canvas, (pose = next))
  requestAnimationFrame(showPose)
}
requestAnimationFrame(showPose)
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
