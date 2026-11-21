/**
 * Software renderer. The scene is drawn into a 640x360 framebuffer that keeps,
 * per pixel: albedo, the world position it came from (so firelight falls on
 * the ground plane as a real circle), a depth for sorting, a normal (from the
 * sprite-normals port in normals.ts) and a planar reflection layer for the
 * pool. Emissives (fire, embers, glows) are depth-tested into a separate layer
 * that is composited on top and blurred into a soft bloom.
 *
 * Output is nearest-neighbour upscaled ("Sworcery" pixels). The ground gets
 * banded, noise-dithered firelight with shadows cast away from the fire;
 * objects get smooth light shaped by their normals.
 *
 * Depth and layering. Every pixel has a depth: the world z of the thing it belongs
 * to (where it stands on the ground; larger is nearer the camera), plus small
 * offsets to order the parts of one thing (a hut's cap +0.01 over its stem). The
 * sky is SKY_DEPTH and the bare ground GROUND_DEPTH.
 * The rules, so things never show through what stands in front of them:
 *
 *   1. Everything a pixel knows (colour, world position, normal, material,
 *      hover tag, glint...) is a channel of the Buf, and only put() writes
 *      objects and only putFx() writes emissives. Nothing keeps per-pixel
 *      state on the side.
 *   2. put() and putFx() depth-test first. A pixel that wins takes over the
 *      whole pixel: put() resets every channel the caller didn't give.
 *   3. putFx() always takes a depth: an ember says how far off it is, a ripple
 *      says GROUND_DEPTH, a shooting star SKY_DEPTH (so any object hides it).
 *      Only rain and labels draw over everything, and they do it after
 *      compositing, outside the buffer.
 *   4. Reflections in the pool are depth-tested the same way (rdep), so the
 *      nearest thing's reflection wins, not the last one drawn. They carry a
 *      normal, specular and tag too, so they are lit like what they mirror.
 *   5. Emissives have their own depth (fx.dep), and whether one shows is
 *      decided after everything is drawn (resolveFx), not when it's drawn: an
 *      ember drawn with the campfire is still hidden by someone who walks in
 *      front of the fire later. Their hover tags are resolved the same way.
 *   6. Objects are opaque. Emissives may be translucent (smoke, glows); a
 *      translucent emissive composites "over" by depth with what's already
 *      in its pixel (in front: over it; behind: under it), never replacing it.
 *      Light that should pile up (the front sheet of the flame) adds instead.
 *
 * Static scenery is also drawn back to front, which only decides ties.
 */
import { FULL_RELIEF } from '../art/art'
import { type PropArt } from '../art/props'
import { type Palette, type Rows } from '../art/sprites'
import { settings } from '../engine/settings'
import { type MoonPlace } from '../moon'
import { type World } from '../sim'
import { type Color } from '../util'
import { H, N, RES, W, project, type Relic } from '../world'
import { compose, gpuCompositor, gpuFrame, present, showDiff } from './compose'
import { BANDS, BAND_BITS, Buf, TILES, makeBuf, makeFx, over } from './frame'
import { GpuCompositor, type GpuFrame, type MoonFace, type MoonLight } from './gpu'
import { tagId } from './labels'
import { prepareLights, type Light, type Prepared } from './lights'
import { unit } from './look'
import { type Normal } from './materials'
import { partNormals, spriteNormals, type Part } from './normals'
import { inspectPixel, pick, tagAt } from './overlays'
import { moonlight, sceneLights } from './scene-lights'
import { buildStatic, fillPool } from './scenery'
import { BUDGET, ShadowMaps, SilhouetteRecorder, type ShadowMap } from './shadows'
import { drawDynamic } from './things'

/** How much stronger another light must be to take a shadow map from one that has it. */
const KEEP_SHADOWS = 1.5

/** How long each stage of the last frame took, in ms. */
export interface Timings {
  draw: number
  compose: number
  present: number
}

/** Everything known about one pixel of the last frame (the editor's inspector). */
export interface PixelInfo {
  x: number
  y: number
  what: 'sky' | 'ground' | 'object'
  owner: string | null
  depth: number
  world: [number, number, number]
  normal: [number, number, number] | null
  albedo: Color
  material: { micro: number; weight: number; spec: number; glint: number }
  emissive: { a: number; color: Color; depth: number; bloom: number } | null
  pool: boolean
  out: Color
  lights: { name: string; kind: string; amount: number; color: Color }[]
}

export class Renderer {
  ctx: CanvasRenderingContext2D
  scale = 4
  tileBoxes = new Float32Array(TILES * 6)
  /** Every shadow caster's silhouette, and each light's shadow map (shadows.ts). */
  readonly shadows = new ShadowMaps()
  /** Glowing caps among the mushroom clusters (screen pixels, found while drawing the static layer). */
  detailGlows: { x: number; y: number; dep: number; ph: number; tag: number }[] = []
  /** The caster being drawn right now: put() records its pixels. */
  private recorder: SilhouetteRecorder | null = null
  prepared: Prepared[] = []
  st = makeBuf() // static layer (ground, trees, props), rebuilt only when the pool level moves
  fb = makeBuf() // per-frame layer
  fx = makeFx()
  /** An empty emissive layer, to clear the touched bands of fx from. */
  fxEmpty = makeFx()
  /** Bands of rows the moving things touched this frame, and last frame (only those differ from the still scene). */
  touched = new Uint8Array(BANDS)
  touchedBefore = new Uint8Array(BANDS)
  /** The still layer changed (built, the pool refilled): the next frame copies, and uploads, everything. */
  stillChanged = true
  uploadAll = true
  /** Counts frames, so the GPU can tell if it missed one (and must upload everything). */
  frameNo = 0
  out = { r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N) }
  outC = document.createElement('canvas')
  outX: CanvasRenderingContext2D
  outImg: ImageData
  fxC = document.createElement('canvas')
  fxX: CanvasRenderingContext2D
  fxImg: ImageData
  /** Whether the static layer is built (false: rebuild it next frame). */
  baked = false
  /** The pool level the static layer is coloured for (it rises and falls with the rain). */
  poolLevel = -1
  /**
   * The ground pixels the pool can ever reach, shore included: their pool metric, whether
   * something stands over them, and their dry colour. Changing the level recolours only these.
   */
  poolZone = { idx: new Int32Array(0), metric: new Float32Array(0), covered: new Uint8Array(0), dry: new Float32Array(0) }
  /** Region id stamped on static pixels while building (0 = none). */
  region = 0
  /** Hover tag stamped on everything drawn while it's set (see tagged()). */
  tag = 0
  /** What each hover tag is called this frame: [name, line of lore]. */
  labels = new Map<number, [string, string, boolean]>()
  /** Pointer position in framebuffer pixels, or null when it's off the canvas. */
  pointer: { x: number; y: number } | null = null
  /** What the pointer is over, as of the last frame (for tests and debugging). */
  hovered: [string, string] | null = null
  /** The key of what the pointer is over (as tagged: 'woodpile', 'fire', 'mush3', 'stick0', …), for the hand. */
  hoverKey: string | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    public relic: Relic = 'antler',
  ) {
    this.ctx = canvas.getContext('2d')!
    for (const c of [this.outC, this.fxC]) {
      c.width = W
      c.height = H
    }
    this.outX = this.outC.getContext('2d')!
    this.fxX = this.fxC.getContext('2d')!
    this.outImg = this.outX.createImageData(W, H)
    this.fxImg = this.fxX.createImageData(W, H)
    this.setScale(4)
  }

  /** How wide the canvas is on the page (CSS pixels), so labels can stay readable when it's small. */
  cssWidth = 0

  /** Output resolution is W*scale x H*scale. */
  setScale(scale: number) {
    this.scale = scale
    this.canvas.width = W * scale
    this.canvas.height = H * scale
  }

  /** Is this screen pixel visible pool surface? */
  isOpenWater = (sx: number, sy: number): boolean => {
    if (sx < 0 || sx >= W || sy < 0 || sy >= H) return false
    const i = sy * W + sx
    return this.fb.pool[i] === 1 && this.fb.obj[i] === 0
  }

  /** Stage timings of the last frame. */
  timings: Timings = { draw: 0, compose: 0, present: 0 }
  /** The lights of the last frame, as gathered (after tuning). */
  lastLights: Light[] = []
  /** The GPU compositor, made on first use (null if WebGL2 isn't there). */
  gpu: GpuCompositor | null | undefined
  /** How the GPU frame compares with the CPU one (the CPU vs GPU view). */
  gpuDiff: { mean: number; max: number; over: number } | null = null
  /** Which path drew the last frame. */
  path: 'cpu' | 'gpu' = 'cpu'
  gpuChannels: GpuFrame['channels'] | null = null

  render(w: World) {
    const t0 = performance.now()
    if (!this.baked) buildStatic(this)
    if (Math.abs(w.poolLevel - this.poolLevel) > 0.004) fillPool(this, w.poolLevel)
    drawDynamic(this, w)
    this.resolveFx()
    const t1 = performance.now()
    this.prepare(w)
    const view = settings.view
    const gpu = settings.gpu && (view === 'final' || view === 'gpudiff') ? gpuCompositor(this) : null
    if (gpu && view === 'gpudiff') {
      // both, and where they differ
      compose(this, w, 'final')
      gpu.render(gpuFrame(this, w))
      showDiff(this, gpu.readLit())
    } else if (gpu) gpu.render(gpuFrame(this, w))
    else compose(this, w)
    this.path = gpu && view === 'final' ? 'gpu' : 'cpu'
    const t2 = performance.now()
    present(this, w, this.path === 'gpu' ? gpu!.canvas : null)
    const t3 = performance.now()
    this.timings = { draw: t1 - t0, compose: t2 - t1, present: t3 - t2 }
  }

  /** The last frame as numbers: the lit image and the glow layer over it (for scripts: images, checks). */
  snapshot() {
    return { lit: this.out, glow: this.fx }
  }

  /** Rebuild the static layer (after editing what's in it). */
  rebuildStatic() {
    this.baked = false
  }

  // ---------------------------------------------------------------- drawing primitives

  /** Write an object pixel if it is nearer than what's there. Returns whether it won the depth test. */
  put(
    B: Buf,
    px: number,
    py: number,
    c: Color,
    wx: number,
    wz: number,
    wy: number,
    baseY: number,
    depth: number,
    noRefl = false,
    nrm?: [number, number, number],
    mh = 0,
    mw = 0,
    spec = 0,
    glint = 0,
  ): boolean {
    px = Math.round(px)
    py = Math.round(py)
    if (this.recorder) this.recorder.add(px, py)
    if (px < 0 || px >= W || py < 0 || py >= H) return false
    const i = py * W + px
    if (depth < B.dep[i]) return false
    B.r[i] = c[0]
    B.g[i] = c[1]
    B.b[i] = c[2]
    B.a[i] = 1
    B.obj[i] = 1
    B.kx[i] = wx
    B.kz[i] = wz
    B.ky[i] = wy
    B.dep[i] = depth
    B.id[i] = this.region
    B.nx[i] = nrm ? nrm[0] : 0
    B.ny[i] = nrm ? nrm[1] : 0
    B.nz[i] = nrm ? nrm[2] : 0
    B.mh[i] = mh
    B.mw[i] = mw
    B.sp[i] = spec
    B.gl[i] = glint
    B.hv[i] = this.tag
    if (B === this.fb) this.touched[py >> BAND_BITS] = 1
    if (noRefl) return true
    // mirror the pixel about its base line into the pool
    const ry = Math.round(2 * baseY - py)
    if (ry < 0 || ry >= H) return true
    const j = ry * W + px
    if (B.pool[j] && !B.obj[j] && depth >= B.rdep[j]) {
      B.rdep[j] = depth
      B.rr[j] = c[0]
      B.rg[j] = c[1]
      B.rb[j] = c[2]
      B.ra[j] = 1
      B.rkx[j] = wx
      B.rkz[j] = wz
      B.rky[j] = wy
      // the mirror flips the normal's vertical component
      B.rnx[j] = nrm ? nrm[0] : 0
      B.rny[j] = nrm ? -nrm[1] : 0
      B.rnz[j] = nrm ? nrm[2] : 0
      B.rsp[j] = spec
      B.rhv[j] = this.tag
      if (B === this.fb) this.touched[ry >> BAND_BITS] = 1
    }
    return true
  }

  /**
   * Write an emissive pixel (rules 3, 5, 6 at the top of the file). It's dropped if an
   * object already drawn is nearer; otherwise it composites over or under what's in the
   * emissive layer by depth. Whether it finally shows is settled in resolveFx().
   */
  putFx(px: number, py: number, c: Color, a: number, baseY: number | undefined, depth: number, bloom = 1, add = false) {
    const fx = this.fx
    px = Math.round(px)
    py = Math.round(py)
    if (px < 0 || px >= W || py < 0 || py >= H) return
    const i = py * W + px
    if (depth < this.fb.dep[i]) return
    if (depth >= fx.dep[i] && this.tag) fx.hv[i] = this.tag
    over(fx.r, fx.g, fx.b, fx.a, fx.bw, fx.dep, i, c, a, bloom, depth, add)
    this.touched[py >> BAND_BITS] = 1
    if (baseY === undefined) return
    const ry = Math.round(2 * baseY - py)
    if (ry < 0 || ry >= H) return
    const j = ry * W + px
    if (this.fb.pool[j] && !this.fb.obj[j]) {
      over(fx.rr, fx.rg, fx.rb, fx.ra, fx.rbw, fx.rdep, j, c, a, bloom, depth, add)
      this.touched[ry >> BAND_BITS] = 1
    }
  }

  /**
   * Settle the emissive layer once everything is drawn (rule 5): an emissive behind the
   * object in its pixel is hidden, and so is a reflected one behind the reflected object
   * (or under something standing in the water). Visible emissives own the pixel's hover tag.
   */
  private resolveFx() {
    const B = this.fb
    const fx = this.fx
    for (let i = 0; i < N; i++) {
      if (fx.a[i] > 0) {
        if (fx.dep[i] < B.dep[i]) fx.a[i] = 0
        else if (fx.hv[i]) B.hv[i] = fx.hv[i]
      }
      if (fx.ra[i] > 0 && (B.obj[i] || (B.ra[i] && fx.rdep[i] < B.rdep[i]))) fx.ra[i] = 0
    }
  }

  /** Draw a char-grid sprite standing at world (wx, wz), with an automatic dark outline and generated normals. */
  /**
   * Draw prop art (props.ts) standing at world (wx, wz), or with its anchor at screen `at`.
   * Each column is lit at its own world x; normals come from the art's parts.
   */
  /** Art standing at world (wx, wz); `at` moves it on screen, and `lift` (world units) says it's held up that high off the ground there. */
  drawArt(B: Buf, art: PropArt, wx: number, wz: number, opts: { dep?: number; at?: [number, number]; noRefl?: boolean; lift?: number } = {}) {
    this.casting(B, wx, wz, () => this.drawArtNow(B, art, wx, wz, opts))
  }

  drawArtNow(B: Buf, art: PropArt, wx: number, wz: number, opts: { dep?: number; at?: [number, number]; noRefl?: boolean; lift?: number }) {
    const [px0, py0, s] = project(wx, 0, wz)
    const [bx, by] = opts.at ?? [px0, py0]
    const lift = ((opts.lift ?? 0) * s) / RES // held up: its pixels are this much higher (in put's units)
    const ground = opts.lift ? py0 : by
    const h = art.rows.length
    const nm = partNormals(art.rows, art.parts, art.pal) // with the parts' textures baked in
    const dep = opts.dep ?? wz
    this.region++
    art.rows.forEach((row, r) =>
      [...row].forEach((ch, c) => {
        if (ch === '.') return
        const k = c - art.anchor
        const src = (r + 2) * nm.w + c + 2
        const nrm: Normal = [nm.nx[src], nm.ny[src], nm.nz[src]]
        const d = dep + (art.depth?.[ch] ?? 0)
        const up = h - 1 - r - art.foot // rows above the ground point (the foot reaches below it, toward us)
        this.put(
          B,
          bx + k,
          by - up,
          art.pal[ch],
          wx + k / s,
          wz,
          Math.max(0, up) / RES + lift,
          ground,
          d,
          opts.noRefl ?? false,
          nrm,
          0,
          0,
          art.shine?.[ch] ?? 0,
        )
      }),
    )
  }

  /**
   * Everything `fn` draws is one shadow caster standing at world (x, z): its pixels become the
   * caster's silhouette (shadows.ts). Nested calls join the outer caster.
   */
  casting<T>(B: Buf, x: number, z: number, fn: () => T, tag = this.tag): T {
    if (this.recorder) return fn()
    const [bx, by, s] = project(x, 0, z)
    this.recorder = new SilhouetteRecorder(x, z, bx, by, s, B === this.st ? 2 : 4, tag)
    try {
      return fn()
    } finally {
      const sil = this.recorder.done()
      this.recorder = null
      if (sil) (B === this.st ? this.shadows.statics : this.shadows.dynamics).push(sil)
    }
  }

  sprite(...args: Parameters<Renderer['spriteNow']>) {
    const [B, , wx, wz, , , opts] = args
    return this.casting(B, wx, wz, () => this.spriteNow(...args), opts?.hover ? tagId(opts.hover.key) : this.tag)
  }

  private spriteNow(
    B: Buf,
    rows: Rows,
    wx: number,
    wz: number,
    pal: Palette,
    flip: boolean,
    opts: {
      lift?: number
      dep?: number
      /** Chars that glow, and how strongly (the art's glow column): their pixels are returned. */
      glow?: Record<string, number>
      /** Hover key and label: these pixels name this thing. */
      hover?: { key: string; name: string; sub: string }
      sinkTo?: number
      shine?: Record<string, number>
      parts?: Part[]
    } = {},
  ) {
    const [bx, by] = project(wx, 0, wz)
    const dep = opts.dep ?? wz + 0.5
    const lift = (opts.lift ?? 0) * RES
    const h = rows.length
    const w = rows[0].length
    const glow: [number, number, number][] = []
    const at = (r: number, c: number) => rows[r][flip ? w - 1 - c : c]
    const clip = opts.sinkTo ?? Infinity // rows below this screen line are under the soil
    const nm = opts.parts ? partNormals(rows, opts.parts, pal) : spriteNormals(rows, (ch) => pal[ch])
    const prevTag = this.tag
    if (opts.hover) {
      this.say(opts.hover.key, opts.hover.name, opts.hover.sub)
      this.tag = tagId(opts.hover.key)
    }
    // no outline: at this resolution the art carries its own edges (values, shaded sides)
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const ch = at(r, c)
        if (ch === '.') continue
        const px = bx - (w >> 1) + c
        const py = by - h + r + 1 - lift
        if (py > clip) continue
        const src = (r + 2) * nm.w + (flip ? w - 1 - c : c) + 2
        const nrm: [number, number, number] = [flip ? -nm.nx[src] : nm.nx[src], nm.ny[src], nm.nz[src]]
        if (this.put(B, px, py, pal[ch], wx, wz, (h - r + lift) / RES, by, dep, false, nrm, 0, 0, opts.shine?.[ch] ?? 0) && opts.glow?.[ch])
          glow.push([px, py, opts.glow[ch]])
      }
    }
    this.tag = prevTag
    return { bx, by, h, glow, dep }
  }

  /** Name a hoverable thing for this frame. `above` puts the name over it (for things behind the fire). */
  say(key: string, name: string, sub: string, above = false) {
    this.labels.set(tagId(key), [name, sub, above])
  }

  /** Draw with every pixel stamped as belonging to `key`, so hovering exactly those pixels names it. */
  tagged<T>(key: string, fn: () => T): T {
    const prev = this.tag
    this.tag = tagId(key)
    const out = fn()
    this.tag = prev
    return out
  }

  // ---------------------------------------------------------------- static layer

  /** Where the lantern was drawn this frame (screen bottom-centre, its ground line, depth), for its glow. */
  lanternAt: { sx: number; sy: number; ground: number; dep: number } | null = null

  /**
   * The moon is a sky object: its face (a sphere's normals bumped by craters, its colour with
   * darker seas, and how much of each texel the disc covers) is built once in its own space, and
   * the compositor draws it every frame wherever it is, to a fraction of a pixel, lit by its own
   * sun (which lights nothing else). So it glides, its face stays put while the light on it turns,
   * clouds pass in front, and it slips behind the treeline and the stone.
   */
  moonFace: MoonFace | null = null
  /** The moon's own sun this frame (toward it) and how much of its dark side shows. */
  moonSun: [number, number, number] = [0, 0, 1]
  earthshine = 0.02
  /** Where the moon is this frame. */
  moonAt: MoonPlace | null = null

  /** How much the craters keep their shading near full (families data). */
  fullRelief = FULL_RELIEF
  /** The hush while the moon is gone (0..1): the stars swell, the forest's own lights glow brighter. */
  hush = 0
  /** The stone turning the moon (0..1): its carving glows. */
  turning = 0
  /** How brightly the stone's carving glows: in the rain, or while it turns the moon. */
  runeOf = (w: World) => Math.max(w.rune, 0.9 * this.turning)

  // ---------------------------------------------------------------- dynamic layer

  // ---------------------------------------------------------------- lighting

  /** The lights that got shadow maps last frame, by name (they keep them: see prepare). */
  shadowed = new Set<string>()

  /** This frame's lights, as prepared (and their shadow maps): both paths light with these. */
  private prepare(w: World) {
    const t = w.t
    this.moon = moonlight(this, w)
    this.moonShadow = settings.layers.shadows && this.moon.shadow > 0.01 ? this.shadows.farMap(this.moon.dir) : null
    const raw = sceneLights(this, w)
    this.lastLights = raw
    // the strongest few shadow-casting lights get shadow maps this frame; those that had one keep it
    // unless another is clearly stronger, so flames flickering about the same strength (candles,
    // burning sticks) don't trade them back and forth, their shadows blinking on and off
    const strength = (l: Light) => (l.color[0] + l.color[1] + l.color[2]) * l.radius * (this.shadowed.has(l.name ?? '') ? KEEP_SHADOWS : 1)
    const casting = new Set(
      raw
        .filter((l) => l.shadows && settings.layers.shadows)
        .sort((a, b) => strength(b) - strength(a))
        .slice(0, BUDGET),
    )
    this.shadowed = new Set([...casting].map((l) => l.name ?? ''))
    this.prepared = prepareLights(raw, t, (l) => (casting.has(l) ? this.shadows.mapFor(l) : null))
  }

  /** This frame's moonlight. */
  moon: MoonLight = { dir: unit(0.15, 0.75, -0.65), half: unit(0.15, 1.05, 0.3), fill: 1, key: 0, hl: 0, shadow: 0 }
  /** The moon's shadow map this frame (over the whole wood), or null. */
  moonShadow: ShadowMap | null = null

  // ---------------------------------------------------------------- output

  /** The hover tag key of the thing at this pixel ('hut0', 'tree12', ...), or null. */
  tagAt(x: number, y: number): string | null {
    return tagAt(this, x, y)
  }

  /** Everything about one pixel of the last frame, and how much each light gives it. */
  inspectPixel(x: number, y: number): PixelInfo | null {
    return inspectPixel(this, x, y)
  }

  /**
   * Name whatever is under the pointer. Every drawn pixel knows what it belongs to, so this is
   * exact: the glowcap behind the grave answers for its own pixels. A pixel or two of slack
   * makes small things easy to catch.
   */
  /** What's under the pointer (in the last frame drawn): sets `hovered` and `hoverKey`, and returns its tag. */
  pick(): number {
    return pick(this)
  }

  /** The hover key of what the visitor's hand is holding (it doesn't name itself while it's in the hand). */
  heldKey: string | null = null
}
