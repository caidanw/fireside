/**
 * Fireside: a small firelit clearing with a primitive simulation.
 * Mount it on a canvas whose parent decides the available space; the canvas
 * is letterboxed to 16:9 and rendered at an integer multiple of 640x360.
 */
import { Renderer, type PixelInfo, type Timings } from '../render/renderer'
import { onArtChange } from '../art/art'
import { Soundscape } from '../audio/soundscape'
import { forgetNormals } from '../render/normals'
import { resetSettings, settings, soundDefaults, type SoundKey } from './settings'
import { createWorld, isRaining, startSong, step, toggleRain, type World } from '../sim'
import { handInput, type HandPose } from './input'
import { rebuildNav } from '../sim/nav'
import { createMush } from '../sim/shroomfolk'
import { H, W, RELICS, type Relic } from '../world'

export interface FiresideOptions {
  glow?: boolean
  debug?: boolean
  rain?: boolean
  /** Time multiplier for the sim (handy for watching slow behaviour). */
  speed?: number
  /** Light objects with generated normal maps (default on). */
  normals?: boolean
  /** Seconds of vigil before the knight goes to rest in the grove (default: a random 4 to 8 minutes). */
  vigil?: number
  /** What stands planted in the fire. */
  relic?: Relic
  /**
   * Start with the sound on. Browsers only let it play after a click or a key, so start paused too
   * and unpause from one (togglePause starts the sound).
   */
  sound?: boolean
  /** Start paused (the scene is drawn, but nothing moves until togglePause()). */
  paused?: boolean
  /** Called with each line of the village's story as it happens. */
  onStory?: (line: string) => void
  /** Called whenever a toggle changes, so the page can reflect it in its controls. */
  onChange?: (state: FiresideState) => void
  /** Called when a pixel is picked with the inspect tool. */
  onInspect?: () => void
}

export interface FiresideState {
  sound: boolean
  rain: boolean
  glow: boolean
  debug: boolean
  normals: boolean
  paused: boolean
}

export interface FiresideStats {
  fps: number
  timings: Timings
  lights: number
  /** Which path drew the last frame, and (in the CPU vs GPU view) how far apart they are. */
  path: 'cpu' | 'gpu'
  gpuDiff: { mean: number; max: number; over: number } | null
}

export type { HandPose } from './input'

export interface Fireside {
  toggleRain(): void
  /** Sound on or off (call from a click or a key: browsers require it). */
  toggleSound(): void
  setVolume(v: number): void
  /** How loud it is right now (0..1): all of it, or one source. */
  soundLevel(key?: SoundKey): number
  /** Play an example of one sound source now (turns sound on). */
  audition(key: SoundKey): void
  toggleGlow(): void
  toggleDebug(): void
  toggleNormals(): void
  togglePause(): void
  state(): FiresideState
  /** The live world, for debugging and tests. */
  inspect(): World
  /** What the pointer is over right now: [name, lore], or null. */
  hovering(): [string, string] | null
  /** How the visitor's hand should look right now (a frame of the hand sprite). */
  handPose(): HandPose
  // ---- for the editor
  /** Advance one frame (while paused). */
  stepFrame(): void
  stats(): FiresideStats
  /** Everything about the inspected pixel, or null. */
  pixel(): PixelInfo | null
  relic(): Relic
  setRelic(r: Relic): void
  /** Someone new walks in, at the edge of the clearing. */
  spawnShroomfolk(): void
  /** Someone free starts a song by the fire; the others bring wood and dance. False if nobody can. */
  startSong(): boolean
  /** The knight's vigil ends now (he rises on the next good night). */
  endVigil(): void
  /** The moon's clock (seconds into its cycle, and its phase), and setting it (to preview a time or phase). */
  moon(): { t: number; phase: number }
  setMoon(m: { t?: number; phase?: number }): void
  /** The hover tag key of the thing at this framebuffer pixel. */
  tagAt(x: number, y: number): string | null
  /** The lights of the last frame. */
  lights(): Renderer['lastLights']
  destroy(): void
}

const MAX_SCALE = 8

export function startFireside(canvas: HTMLCanvasElement, options: FiresideOptions = {}): Fireside {
  const world: World = createWorld()
  const renderer = new Renderer(canvas, options.relic && RELICS.includes(options.relic) ? options.relic : 'antler')
  if (options.glow === false) settings.layers.bloom = false
  if (options.normals === false) settings.layers.normals = false
  if (options.debug) settings.overlays.states = true
  if (options.speed) settings.speed = options.speed
  if (options.rain) toggleRain(world)
  if (options.sound) settings.sound.on = true
  if (options.paused) settings.paused = true
  if (options.vigil) world.knight.vigilLength = options.vigil

  const sound = new Soundscape()
  sound.setVolume(settings.sound.volume)
  const state = (): FiresideState => ({
    sound: settings.sound.on,
    rain: isRaining(world),
    glow: settings.layers.bloom,
    debug: settings.overlays.states,
    normals: settings.layers.normals,
    paused: settings.paused,
  })
  const changed = () => options.onChange?.(state())

  // ---------- sizing: fit 16:9 in the parent, render at an integer scale for crisp pixels
  const fit = () => {
    const parent = canvas.parentElement!
    const box = parent.getBoundingClientRect()
    let cssW = Math.min(box.width, (box.height * W) / H)
    // a parent marked data-crisp (the editor) gets a whole number of device pixels per pixel,
    // as long as that still fills most of the space
    if ('crisp' in parent.dataset) {
      const k = Math.floor((cssW * devicePixelRatio) / W)
      if (k >= 1 && (k * W) / devicePixelRatio >= cssW * 0.75) cssW = (k * W) / devicePixelRatio
    }
    const cssH = (cssW * H) / W
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    renderer.cssWidth = cssW
    const scale = Math.max(1, Math.min(MAX_SCALE, Math.ceil((cssW * devicePixelRatio) / W)))
    if (canvas.width !== W * scale) renderer.setScale(scale)
  }
  // the art changed (the editor): forget cached normals and rebuild the static layer
  const offArt = onArtChange((file) => {
    forgetNormals()
    renderer.rebuildStatic()
    if (file === 'lights') resetSettings('lights')
    if (file === 'sound') settings.sound.sources = soundDefaults()
    if (file === 'layout') rebuildNav()
  })

  const ro = new ResizeObserver(fit)
  ro.observe(canvas.parentElement!)
  fit()

  // ---------- input: the visitor's hand (input.ts)
  const hand = handInput(canvas, renderer, world, options.onInspect)

  // ---------- loop
  let raf = 0
  let last = performance.now()
  let wasRaining = isRaining(world)
  let stepOnce = false
  let fps = 60
  // The world runs on, and is heard, while the tab is hidden too: the browser draws no frames then,
  // so a timer ticks it instead (undrawn). Hidden tabs' timers are slowed (to once a second, or
  // less often, though browsers spare a tab that's playing sound), so each tick runs the world on
  // for however long it's been, a frame's step at a time, and schedules the sound far enough ahead
  // to last until the next.
  const advance = (now: number, hidden: boolean) => {
    const real = now - last
    last = now
    if (!hidden) fps = fps * 0.95 + (1000 / Math.max(1, real)) * 0.05
    if (stepOnce) step(world, 1 / 60, renderer.isOpenWater)
    else if (!settings.paused)
      for (let left = Math.min(hidden ? 2 : 0.05, real / 1000); left > 0; left -= 0.05) step(world, Math.min(0.05, left) * settings.speed, renderer.isOpenWater)
    stepOnce = false
    if (settings.fireHeat !== null) world.fire.heat = settings.fireHeat
    if (!hidden) renderer.render(world)
    if (settings.sound.on) sound.update(world, hidden ? Math.min(2.5, (real / 1000) * 1.5 + 0.1) : 0.05)
    // (taken off the queue whether or not anyone's listening: an optional call skips its arguments)
    for (const line of world.story.splice(0)) options.onStory?.(line)
    // weather changes on its own timer (and toggles land a tick later), so report it when it happens
    if (isRaining(world) !== wasRaining) {
      wasRaining = !wasRaining
      changed()
    }
  }
  const frame = (now: number) => {
    advance(now, false)
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  let timer = 0
  const onVisibility = () => {
    window.clearInterval(timer)
    if (document.hidden) timer = window.setInterval(() => advance(performance.now(), true), 100)
  }
  document.addEventListener('visibilitychange', onVisibility)

  const toggle = (f: () => void) => () => {
    f()
    changed()
  }
  const api: Fireside = {
    toggleRain() {
      toggleRain(world) // takes effect on the next tick; the loop reports the change
    },
    toggleSound: toggle(() => {
      settings.sound.on = !settings.sound.on
      if (settings.sound.on && !settings.paused) sound.start()
      else sound.stop()
    }),
    setVolume(v) {
      settings.sound.volume = v
      sound.setVolume(v)
    },
    soundLevel: (key) => sound.level(key),
    audition(key) {
      if (!settings.sound.on) api.toggleSound()
      sound.audition(key)
    },
    toggleGlow: toggle(() => (settings.layers.bloom = !settings.layers.bloom)),
    toggleDebug: toggle(() => (settings.overlays.states = !settings.overlays.states)),
    toggleNormals: toggle(() => (settings.layers.normals = !settings.layers.normals)),
    togglePause: toggle(() => {
      settings.paused = !settings.paused
      // a paused world is a silent one: the audio is suspended with it, so every scheduled
      // sound freezes where it is and carries on when it resumes
      if (settings.sound.on) {
        if (settings.paused) sound.stop()
        else sound.start()
      }
    }),
    state,
    inspect: () => world,
    hovering: () => renderer.hovered,
    handPose: hand.handPose,
    stepFrame: () => (stepOnce = true),
    stats: () => ({ fps, timings: renderer.timings, lights: renderer.lastLights.length, path: renderer.path, gpuDiff: renderer.gpuDiff }),
    pixel: () => (settings.inspect ? renderer.inspectPixel(settings.inspect.x, settings.inspect.y) : null),
    relic: () => renderer.relic,
    setRelic: (r) => (renderer.relic = r),
    startSong: () => startSong(world),
    spawnShroomfolk() {
      const a = Math.random() * Math.PI * 2
      world.mush.push(createMush(world, Math.cos(a) * 30, Math.sin(a) * 22))
    },
    endVigil: () => (world.knight.vigilLength = Math.min(world.knight.vigilLength, world.knight.vigil)),
    moon: () => ({ ...world.moon }),
    setMoon(m) {
      if (m.t !== undefined) world.moon.t = Math.max(0, m.t)
      if (m.phase !== undefined) world.moon.phase = m.phase
    },
    lights: () => renderer.lastLights,
    tagAt: (x, y) => renderer.tagAt(x, y),
    destroy() {
      cancelAnimationFrame(raf)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      offArt()
      sound.stop()
      ro.disconnect()
      hand.detach()
    },
  }
  return api
}
