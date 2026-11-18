/**
 * Fireside: a small firelit clearing with a primitive simulation.
 * Mount it on a canvas whose parent decides the available space; the canvas
 * is letterboxed to 16:9 and rendered at an integer multiple of 640x360.
 */
import { Renderer, type PixelInfo, type Timings } from './renderer'
import { onArtChange } from './art'
import { Soundscape } from './audio'
import { forgetNormals } from './normals'
import { resetSettings, settings, soundDefaults, type SoundKey } from './settings'
import { createWorld, grab, isRaining, leaveHand, moveHand, release, startSong, step, takeable, toggleRain, type World } from './sim'
import { rebuildNav } from './sim/nav'
import { createMush } from './sim/shroomfolk'
import { H, W, project, unproject, RELICS, type Relic } from './world'

export interface DarkForestOptions {
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
  onChange?: (state: DarkForestState) => void
  /** Called when a pixel is picked with the inspect tool. */
  onInspect?: () => void
}

export interface DarkForestState {
  sound: boolean
  rain: boolean
  glow: boolean
  debug: boolean
  normals: boolean
  paused: boolean
}

export interface DarkForestStats {
  fps: number
  timings: Timings
  lights: number
  /** Which path drew the last frame, and (in the CPU vs GPU view) how far apart they are. */
  path: 'cpu' | 'gpu'
  gpuDiff: { mean: number; max: number; over: number } | null
}

export type HandPose = 'point' | 'open' | 'fist' | 'torch' | 'pinch'

export interface DarkForest {
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
  state(): DarkForestState
  /** The live world, for debugging and tests. */
  inspect(): World
  /** What the pointer is over right now: [name, lore], or null. */
  hovering(): [string, string] | null
  /** How the visitor's hand should look right now (a frame of the hand sprite). */
  handPose(): HandPose
  // ---- for the editor
  /** Advance one frame (while paused). */
  stepFrame(): void
  stats(): DarkForestStats
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

export function startDarkForest(canvas: HTMLCanvasElement, options: DarkForestOptions = {}): DarkForest {
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
  const state = (): DarkForestState => ({
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

  // ---------- input: the visitor's hand. Hover names things (and spooks the deer); press on
  // something to take it, carry it, and let go to set it down (or a click picks it up and the next
  // click sets it down). On a touchscreen, what you carry is held up above your finger, so you can
  // see it, and a tap leaves the name of what you tapped showing.
  /** How high the hand holds things (world units), and how far above a finger (CSS pixels). */
  const HOLD = 10
  const ABOVE_FINGER = 40
  const toScreen = (e: PointerEvent, lifted = false) => {
    const r = canvas.getBoundingClientRect()
    const up = lifted && e.pointerType === 'touch' ? ABOVE_FINGER : 0
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - up - r.top) / r.height) * H }
  }
  const toWorld = (e: PointerEvent) => {
    const { x, y } = toScreen(e)
    const q = unproject(x, y)
    return q ? { x: q[0], z: q[1] } : null
  }
  /** Beyond this depth the hand holds things higher instead of further away (over the far trees and the sky). */
  const FAR = -70
  /** The ground point under a thing held at screen point (x, y), and how high it's held: [x, z, height]. */
  const holdAt = (x: number, y: number): [number, number, number] => {
    let q = unproject(x, y + HOLD * project(0, 0, 0)[2])
    for (let i = 0; i < 3 && q; i++) q = unproject(x, y + HOLD * project(0, 0, q[1])[2]) // refine for depth
    if (q && q[1] > FAR) return [q[0], q[1], HOLD]
    const [cx, gy, s] = project(0, 0, FAR)
    return [(x - cx) / s, FAR, Math.max(HOLD, (gy - y) / s)]
  }
  let pressed = false
  let pressAt = { x: 0, y: 0, t: 0 }
  /** Took hold with a click (short and still): the hand keeps it until the next click. */
  let sticky = false
  let pinned = false
  /** A finger on something it could take: dragging takes it, lifting the finger just names it. */
  let reaching: string | null = null
  const placeHand = (e: PointerEvent) => {
    const { x, y } = toScreen(e, !!world.hand?.held)
    const [hx, hz, hy] = holdAt(x, y)
    moveHand(world, hx, hz, hy)
  }
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && !pressed) return
    // a finger that's set off dragging from something takes it (a tap only names it)
    if (reaching && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) >= 6) {
      grab(world, reaching, world.hand!.x, world.hand!.z, world.hand!.y)
      reaching = null
    }
    pinned = false
    renderer.pointer = toScreen(e, !!world.hand?.held) // hover works anywhere, including over the sky
    world.cursor = toWorld(e) // the deer only cares about the ground
    placeHand(e)
  }
  const onLeave = (e: PointerEvent) => {
    if (pinned || (e.pointerType === 'touch' && !world.hand?.held)) return // a tapped name stays up
    renderer.pointer = null
    world.cursor = null
    leaveHand(world)
  }
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const { x, y } = toScreen(e)
    if (settings.tool === 'move') return // the editor handles it
    if (settings.tool === 'inspect') {
      settings.inspect = { x: Math.floor(x), y: Math.floor(y) }
      options.onInspect?.()
      return
    }
    pressed = true
    pressAt = { x: e.clientX, y: e.clientY, t: performance.now() }
    renderer.pointer = { x, y }
    renderer.pick() // what's under a finger that's only just touched down
    // keep carrying past the canvas's edge (a pointer the browser doesn't know, like a synthetic one, can't be captured)
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {}
    placeHand(e)
    if (world.hand?.held) return // holding something from a click: this click's release sets it down
    sticky = false
    if (e.pointerType === 'touch') reaching = takeable(world, renderer.hoverKey) ? renderer.hoverKey : null
    else if (grab(world, renderer.hoverKey, world.hand!.x, world.hand!.z, world.hand!.y)) placeHand(e)
  }
  const onUp = (e: PointerEvent) => {
    if (!pressed) return
    pressed = false
    reaching = null
    const still = Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) < 6 && performance.now() - pressAt.t < 350
    if (world.hand?.held && still && !sticky && e.pointerType !== 'touch') {
      sticky = true // a click took it: keep hold until the next click
      return
    }
    sticky = false
    release(world)
    if (e.pointerType === 'touch') {
      // the tapped thing's name stays up until the next tap
      pinned = still
      if (!pinned) renderer.pointer = null
      world.cursor = null
    }
  }
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  const handPose = (): HandPose => {
    const held = world.hand?.held
    if (held?.kind === 'stick') return held.lit ? 'torch' : 'fist'
    if (held?.kind === 'log') return 'fist'
    if (held) return 'pinch'
    if (pressed) return 'fist'
    return renderer.pointer && takeable(world, renderer.hoverKey) ? 'open' : 'point'
  }

  // ---------- loop
  let raf = 0
  let last = performance.now()
  let wasRaining = isRaining(world)
  let stepOnce = false
  let fps = 60
  const frame = (now: number) => {
    const real = now - last
    fps = fps * 0.95 + (1000 / Math.max(1, real)) * 0.05
    const dt = Math.min(0.05, real / 1000) * settings.speed
    last = now
    if (!settings.paused || stepOnce) step(world, stepOnce ? 1 / 60 : dt, renderer.isOpenWater)
    stepOnce = false
    if (settings.fireHeat !== null) world.fire.heat = settings.fireHeat
    renderer.render(world)
    if (settings.sound.on) sound.update(world)
    while (world.story.length) options.onStory?.(world.story.shift()!)
    // weather changes on its own timer (and toggles land a tick later), so report it when it happens
    if (isRaining(world) !== wasRaining) {
      wasRaining = !wasRaining
      changed()
    }
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  const toggle = (f: () => void) => () => {
    f()
    changed()
  }
  const api: DarkForest = {
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
    handPose,
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
      offArt()
      sound.stop()
      ro.disconnect()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    },
  }
  return api
}
