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
import { DATA, FULL_RELIEF, SPRITES } from '../art/art'
import { CANDLE, HUT, HUT_DOOR, LOG, PACK, RELIC_ART, SKULL, STICK, SWORD, seatLog, type PropArt } from '../art/props'
import {
  CROW,
  CROW_PAL,
  DEER,
  DEER_PAL,
  DEER_PARTS,
  FROG,
  FROG_PAL,
  FROG_PARTS,
  GLOWCAP,
  GLOWCAP_PAL,
  GLOWCAP_PARTS,
  KEEPER_PALS,
  KEEPER_PARTS,
  KEEPER_SHINE,
  KNIGHT,
  KNIGHT_KNEEL,
  KNIGHT_NOD,
  KNIGHT_PAL,
  KNIGHT_PARTS,
  KNIGHT_SHINE,
  KNIGHT_STAND,
  KNIGHT_TOSS,
  MUSH,
  MUSH_KEEPER,
  MUSH_PALS,
  MUSH_PARTS,
  elk,
  type Palette,
  type Rows,
} from '../art/sprites'
import { settings, type View } from '../engine/settings'
import { MOON_R, moonPlace, moonTiming, stoneX, type MoonPlace } from '../moon'
import { NOTE_LIFE, WALKING, doorOpen, hutOccupancy, isElder, isMoving, isRaining, lightRadius, perchPos, rainAmount, type Mush, type World } from '../sim'
import { TOSS } from '../sim/knight'
import { walkable } from '../sim/nav'
import { clamp, hash, hex, mix, rngFrom, vnoise, type Color } from '../util'
import {
  BUSHES,
  C,
  DETAILS,
  EYES,
  H,
  HEARTHSTONES,
  HORIZON,
  KNIGHT_GRAVE,
  N,
  PADS,
  POOL_MAX,
  PROPS,
  REEDS,
  RES,
  SHROOMS,
  STONE_RING,
  TREES,
  TUFTS,
  UNDERGROWTH,
  W,
  ZOOM,
  inPool,
  mistAt,
  poolMetric,
  project,
  scaleAt,
  unproject,
  type Bush,
  type Detail,
  type Point,
  type Relic,
  type Tree,
} from '../world'
import { BANDS, BAND_BITS, Buf, GROUND_DEPTH, SKY_DEPTH, TILES, TILES_X, TILE_BITS, copyBands, copyBuf, makeBuf, makeFx, over } from './frame'
import { GpuCompositor, type GpuFrame, type MoonFace, type MoonLight } from './gpu'
import { BUSH_NAMES, DETAIL_NAMES, FIRE_WORDS, FONT, LABEL_MIN, STATE_WORDS, TAGS, TAG_KEYS, tagId, wrapText } from './labels'
import { cullLights, gatherLight, groundGrain, prepareLights, type Light, type Prepared } from './lights'
import {
  CLOUD,
  CLOUD_RIM,
  FIRE_Y,
  FLAME,
  FLASH,
  GLOW,
  MOONLIGHT,
  MOON_AT,
  MOON_DISC,
  MOON_KEY,
  RELIEF_LIGHT,
  STARS,
  VIEW,
  cloudAt,
  dot3,
  inMoon,
  skyAt,
  unit,
} from './look'
import { WEIGHT, shape, textureAt, type Normal } from './materials'
import { lightness, partNormals, reliefNormals, spriteNormals, type Part } from './normals'
import { BUDGET, OBJECT_DARKNESS, ShadowMaps, SilhouetteRecorder, shadowAt, shadowOnObject, type ShadowMap } from './shadows'
import {
  BAT,
  CROWN_PX,
  EDGE_REEDS,
  EDGE_TUFTS,
  Foliage,
  HELD_STICK,
  Lobe,
  NOTES,
  OWL,
  RELICS,
  SITTING,
  TRIGON_INSIDE,
  TRIGON_LIP,
  ZED,
  bakeMicroDetail,
  capOf,
  disc,
  highlights,
  hutChimney,
  hutOpenings,
  lanternCut,
  mushHop,
  owlTree,
  stickPixels,
  stickTip,
  surf,
  texAt,
  trigonAt,
  trigonPx,
} from './shapes'

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
  private ctx: CanvasRenderingContext2D
  private scale = 4
  private tileBoxes = new Float32Array(TILES * 6)
  /** Every shadow caster's silhouette, and each light's shadow map (shadows.ts). */
  readonly shadows = new ShadowMaps()
  /** Glowing caps among the mushroom clusters (screen pixels, found while drawing the static layer). */
  private detailGlows: { x: number; y: number; dep: number; ph: number; tag: number }[] = []
  /** The caster being drawn right now: put() records its pixels. */
  private recorder: SilhouetteRecorder | null = null
  private prepared: Prepared[] = []
  private st = makeBuf() // static layer (ground, trees, props), rebuilt only when the pool level moves
  private fb = makeBuf() // per-frame layer
  private fx = makeFx()
  /** An empty emissive layer, to clear the touched bands of fx from. */
  private fxEmpty = makeFx()
  /** Bands of rows the moving things touched this frame, and last frame (only those differ from the still scene). */
  private touched = new Uint8Array(BANDS)
  private touchedBefore = new Uint8Array(BANDS)
  /** The still layer changed (built, the pool refilled): the next frame copies, and uploads, everything. */
  private stillChanged = true
  private uploadAll = true
  /** Counts frames, so the GPU can tell if it missed one (and must upload everything). */
  private frameNo = 0
  private out = { r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N) }
  private outC = document.createElement('canvas')
  private outX: CanvasRenderingContext2D
  private outImg: ImageData
  private fxC = document.createElement('canvas')
  private fxX: CanvasRenderingContext2D
  private fxImg: ImageData
  /** Whether the static layer is built (false: rebuild it next frame). */
  private baked = false
  /** The pool level the static layer is coloured for (it rises and falls with the rain). */
  private poolLevel = -1
  /**
   * The ground pixels the pool can ever reach, shore included: their pool metric, whether
   * something stands over them, and their dry colour. Changing the level recolours only these.
   */
  private poolZone = { idx: new Int32Array(0), metric: new Float32Array(0), covered: new Uint8Array(0), dry: new Float32Array(0) }
  /** Region id stamped on static pixels while building (0 = none). */
  private region = 0
  /** Hover tag stamped on everything drawn while it's set (see tagged()). */
  private tag = 0
  /** What each hover tag is called this frame: [name, line of lore]. */
  private labels = new Map<number, [string, string, boolean]>()
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
  private gpu: GpuCompositor | null | undefined
  /** How the GPU frame compares with the CPU one (the CPU vs GPU view). */
  gpuDiff: { mean: number; max: number; over: number } | null = null
  /** Which path drew the last frame. */
  path: 'cpu' | 'gpu' = 'cpu'
  private gpuChannels: GpuFrame['channels'] | null = null

  render(w: World) {
    const t0 = performance.now()
    if (!this.baked) this.buildStatic()
    if (Math.abs(w.poolLevel - this.poolLevel) > 0.004) this.fillPool(w.poolLevel)
    this.drawDynamic(w)
    this.resolveFx()
    const t1 = performance.now()
    this.prepare(w)
    const view = settings.view
    const gpu = settings.gpu && (view === 'final' || view === 'gpudiff') ? this.gpuCompositor() : null
    if (gpu && view === 'gpudiff') {
      // both, and where they differ
      this.compose(w, 'final')
      gpu.render(this.gpuFrame(w))
      this.showDiff(gpu.readLit())
    } else if (gpu) gpu.render(this.gpuFrame(w))
    else this.compose(w)
    this.path = gpu && view === 'final' ? 'gpu' : 'cpu'
    const t2 = performance.now()
    this.present(w, this.path === 'gpu' ? gpu!.canvas : null)
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
  private put(
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
  private putFx(px: number, py: number, c: Color, a: number, baseY: number | undefined, depth: number, bloom = 1, add = false) {
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
  private drawArt(B: Buf, art: PropArt, wx: number, wz: number, opts: { dep?: number; at?: [number, number]; noRefl?: boolean; lift?: number } = {}) {
    this.casting(B, wx, wz, () => this.drawArtNow(B, art, wx, wz, opts))
  }

  private drawArtNow(B: Buf, art: PropArt, wx: number, wz: number, opts: { dep?: number; at?: [number, number]; noRefl?: boolean; lift?: number }) {
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
  private casting<T>(B: Buf, x: number, z: number, fn: () => T, tag = this.tag): T {
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

  private sprite(...args: Parameters<Renderer['spriteNow']>) {
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
  private say(key: string, name: string, sub: string, above = false) {
    this.labels.set(tagId(key), [name, sub, above])
  }

  /** Draw with every pixel stamped as belonging to `key`, so hovering exactly those pixels names it. */
  private tagged<T>(key: string, fn: () => T): T {
    const prev = this.tag
    this.tag = tagId(key)
    const out = fn()
    this.tag = prev
    return out
  }

  // ---------------------------------------------------------------- static layer

  /** The dry ground's colour (fillPool() puts the water and its shore over it). */
  private groundCol(x: number, z: number): Color {
    const d = Math.hypot(x, z)
    const n = vnoise(x * 0.07, z * 0.09)
    const n2 = vnoise(x * 0.4 + 9, z * 0.4)
    let c = mix(C.grassA, C.grassB, n)
    if (n2 > 0.72) c = C.moss
    // worn paths: out to the road (lantern), and over to the hollow (huts)
    const toRoad = x < -14 && Math.abs(z - (6 + (x + 14) * -0.12 + Math.sin(x * 0.08) * 3)) < 3.2 + n2 * 1.5
    const toHollow = x < -10 && x > -56 && Math.abs(z - (-4 + (x + 10) * 0.42)) < 2.4 + n2
    if (toRoad || toHollow) c = mix(C.path, c, 0.25)
    if (d < 24) c = mix(C.dirt, c, clamp((d - 13) / 11 + (n2 - 0.5) * 0.6))
    return c
  }

  /**
   * Foliage in the Sword & Sworcery manner: one flat silhouette (the union of round lobes),
   * pale speckles that gather toward the top of each lobe, and dotted arcs tracing the lobes'
   * upper rims (bushes). Later lobes sit in front of earlier ones. Normals are soft domes, so firelight still finds the form.
   */
  private foliage(B: Buf, lobes: Lobe[], f: Foliage) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const l of lobes) {
      x0 = Math.min(x0, Math.floor(l.cx - l.rx))
      x1 = Math.max(x1, Math.ceil(l.cx + l.rx))
      y0 = Math.min(y0, Math.floor(l.cy - l.ry))
      y1 = Math.min(f.clipY ?? Infinity, Math.max(y1, Math.ceil(l.cy + l.ry)))
    }
    if (x1 < 0 || x0 >= W || y1 < 0 || y0 >= H) return
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const owner = new Int16Array(bw * bh).fill(-1)
    // each lobe's rim is scalloped: little bumps a couple of pixels deep, like clumps of leaves
    const bumps = lobes.map((l, li) => ({ k: Math.max(6, Math.min(16, Math.round(l.rx / 3))), ph: hash(f.seed, li) * 6.28, amp: Math.min(0.09, 2.2 / l.rx) }))
    const rim = (li: number, u: number, v: number) => 1 - bumps[li].amp + bumps[li].amp * Math.sin(Math.atan2(v, u) * bumps[li].k + bumps[li].ph)
    lobes.forEach((l, li) => {
      for (let py = Math.max(y0, Math.floor(l.cy - l.ry)); py <= Math.min(y1, l.cy + l.ry); py++) {
        for (let px = Math.max(x0, Math.floor(l.cx - l.rx)); px <= Math.min(x1, l.cx + l.rx); px++) {
          const u = (px - l.cx) / l.rx
          const v = (py - l.cy) / l.ry
          if (Math.hypot(u, v) <= rim(li, u, v) && (!f.clipAt || py <= f.clipAt(px))) owner[(py - y0) * bw + px - x0] = li
        }
      }
    })
    const at = (px: number, py: number) => (px < x0 || px > x1 || py < y0 || py > y1 ? -1 : owner[(py - y0) * bw + px - x0])
    // where each pixel sits within its lobe: u, v in -1..1 and how many pixels in from the rim
    const place = (li: number, px: number, py: number) => {
      const l = lobes[li]
      const u = (px - l.cx) / l.rx
      const v = (py - l.cy) / l.ry
      return { u, v, edge: (rim(li, u, v) - Math.hypot(u, v)) * Math.min(l.rx, l.ry) }
    }
    // the highlights: fewer of them, paler or closer to the leaves, glinting less (families.json)
    const hl = f.highlights
    const speck = mix(f.base, f.speck, hl.strength)
    const dim = mix(f.base, f.dim, hl.strength)
    this.region++
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const li = at(px, py)
        if (li < 0) continue
        const { u, v, edge } = place(li, px, py)
        let c = f.base
        const top = clamp(0.15 - v * 0.85)
        const n = hash(px * 7 + f.seed, py * 13)
        if (f.arcs && v < 0.2 && edge >= 1.5 && edge < 2.5 && ((px + py) & 1) === 0 && hash(px * 3 + f.seed, py * 7) < hl.amount)
          c = f.speck // the dotted rim
        else if (f.arcs && v < 0 && edge >= 4.5 && edge < 5.5 && n < 0.45 * hl.amount) c = f.dim
        else if (edge > 1 && n < (0.012 + 0.11 * top) * hl.amount) c = hash(py, px * 3 + f.seed) < 0.4 ? f.speck : f.dim
        const glint = (c === f.speck ? 1 : c === f.dim ? 0.4 : 0) * hl.glint
        if (c === f.speck) c = speck
        else if (c === f.dim) c = dim
        const d = shape.dome(u, v)
        let nrm: Normal
        const D = f.depth
        if (D) {
          // the lobe a real dome, made of leaf clumps (cells `size` px across, jittered), each its own little dome
          const cs = Math.max(3, D.size)
          const gx = Math.floor(px / cs)
          const gy = Math.floor(py / cs)
          let best = 1e9
          let second = 1e9
          let cu = 0
          let cv = 0
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const cx = (gx + dx + 0.2 + 0.6 * hash(gx + dx, (gy + dy) * 7 + f.seed)) * cs
              const cy = (gy + dy + 0.2 + 0.6 * hash((gx + dx) * 5 + f.seed, gy + dy)) * cs
              const dd = Math.hypot(px - cx, (py - cy) * 1.15)
              if (dd < best) {
                second = best
                best = dd
                cu = (px - cx) / (cs * 0.8)
                cv = (py - cy) / (cs * 0.8)
              } else if (dd < second) second = dd
            }
          const cl = shape.dome(clamp((cu + 1) / 2) * 2 - 1, clamp((cv + 1) / 2) * 2 - 1)
          const x = d[0] * 0.7 + cl[0] * D.clumps
          const y = d[1] * 0.7 + cl[1] * D.clumps + 0.1
          const z = d[2] * 0.7 + cl[2] * D.clumps
          const l = Math.hypot(x, y, z) || 1
          nrm = [x / l, y / l, z / l]
          // painted depth: crevices between clumps, contact shadow where a lobe in front overlaps,
          // back lobes darker, each lobe lighter on top and darker underneath, each clump too
          const P = D.paint
          let shade = second - best < 1.2 ? 1 - 0.28 * P : 1
          for (let k = 1; k <= 2; k++)
            for (const [ox, oy] of [
              [0, -k],
              [k, 0],
              [-k, 0],
              [0, k],
            ])
              if (at(px + ox, py + oy) > li) shade = Math.min(shade, 1 - (k === 1 ? 0.45 : 0.18) * P)
          shade *= 1 - (0.12 * P * (lobes.length - 1 - li)) / Math.max(1, lobes.length - 1)
          shade *= v < -0.45 ? 1 + 0.22 * P : v > 0.5 ? 1 - 0.28 * P : v > 0.15 ? 1 - 0.14 * P : 1
          shade *= cl[1] > 0.45 ? 1 + 0.1 * P : cl[1] < -0.3 ? 1 - 0.12 * P : 1
          shade *= D.lift
          c = [c[0] * shade, c[1] * shade, c[2] * shade]
        } else {
          const l = Math.hypot(d[0] * 0.45, d[1] * 0.45 + 0.12, 1)
          nrm = [(d[0] * 0.45) / l, (d[1] * 0.45 + 0.12) / l, 1 / l]
        }
        this.put(
          B,
          px,
          py,
          c,
          f.x + (px - f.bx) / f.s,
          f.z,
          f.heightAt(py),
          f.by,
          f.dep + li * 0.0004,
          false,
          nrm,
          textureAt(f.surface.texture, px, py, f.seed),
          f.surface.relief,
          f.depth?.sheen ?? 0,
          glint,
        )
      }
    }
  }

  /**
   * A tree: a straight flat trunk with a thin moonlit edge, and a crown of a few big lobes
   * (sometimes a lower clump on a side branch). Crowns keep clear of the moon and, for trees
   * standing in front of it, the trigon stone.
   */
  private drawTree(B: Buf, t: Tree) {
    const [bx, by, s] = project(t.x, 0, t.z)
    const ys = by - project(t.x, 1, t.z)[1]
    const h = 95 * t.h
    const tw = Math.max(2, Math.round(1.8 * t.w * s))
    const rng = rngFrom(t.seed)
    const R = Math.max(6, (7 + rng() * 5) * t.w * s)
    const cx = bx + (rng() - 0.5) * R * 0.3
    const cy = by - h * (0.48 + rng() * 0.22) * ys
    const lobes: Lobe[] = []
    const side = rng() < 0.5 ? -1 : 1
    let branch: Lobe | null = null
    if (rng() < 0.45) {
      // a lower clump on a branch
      const br = R * (0.45 + rng() * 0.15)
      branch = { cx: bx + side * (R * 0.7 + br * 0.4), cy: cy + R * (1.3 + rng() * 0.6), rx: br, ry: br * 1.05 }
      lobes.push(branch)
    }
    for (const k of [-1, 1]) {
      const r = R * (0.5 + rng() * 0.2)
      lobes.push({ cx: cx + k * R * (0.55 + rng() * 0.25), cy: cy + R * (0.15 + rng() * 0.35), rx: r, ry: r * 1.05 })
    }
    lobes.push({ cx, cy, rx: R, ry: R * 1.08 })
    lobes.push({ cx: cx + (rng() - 0.5) * R * 0.5, cy: cy - R * (0.55 + rng() * 0.2), rx: R * 0.62, ry: R * 0.62 })
    // keep the moon and the trigon in view
    const TRIGON_AT = trigonAt()
    const clearOf = (l: Lobe) => {
      const moon = Math.hypot(l.cx - MOON_AT[0], l.cy - MOON_AT[1]) - l.rx < 20
      const trig = t.z > PROPS.trigon.z && Math.abs(l.cx - TRIGON_AT[0]) < l.rx + 20 && l.cy + l.ry > TRIGON_AT[1] - 6
      return !moon && !trig
    }
    for (const l of lobes) for (let k = 0; k < 6 && !clearOf(l); k++) ((l.rx *= 0.75), (l.ry *= 0.75))
    const crown = lobes.filter((l) => clearOf(l) && l.rx >= 3)
    // the trunk, up into the crown
    const trunkTop = Math.round(cy)
    const bark = surf('tree', 'trunk').relief
    this.region++
    for (let py = by; py >= trunkTop; py--) {
      for (let k = 0; k < tw; k++) {
        const u = tw > 1 ? ((k + 0.5) / tw) * 2 - 1 : 0
        const px = bx - (tw >> 1) + k
        this.put(
          B,
          px,
          py,
          k === 0 && tw > 2 ? C.trunkRim : C.trunk,
          t.x + u,
          t.z,
          (by - py) / ys,
          by,
          t.z,
          false,
          shape.cylinder(u * 0.6),
          texAt('tree', 'trunk', px, py, t.seed),
          bark,
        )
      }
    }
    const q = DATA.families.tree?.footprint ?? 0
    if (q > 0) {
      // seen from a little above: the foot flares a little and its bottom edge curves toward us
      const R = tw / 2 + 1.5
      for (let k = -2; k < tw + 2; k++) {
        const x = k + 0.5 - tw / 2
        if (Math.abs(x) > R) continue
        const bottom = by + Math.round(q * Math.sqrt(Math.max(0, R * R - x * x)))
        const top = k < 0 || k >= tw ? by - (Math.abs(x) > R - 1 ? 0 : 1) : by + 1
        for (let py = top; py <= bottom; py++) {
          const px = bx - (tw >> 1) + k
          this.put(
            B,
            px,
            py,
            k <= 0 && tw > 2 ? C.trunkRim : C.trunk,
            t.x + x / s,
            t.z,
            0,
            by,
            t.z,
            false,
            shape.cylinder((x / R) * 0.8),
            texAt('tree', 'trunk', px, py, t.seed),
            bark,
          )
        }
      }
    } else if (tw >= 2) {
      this.put(B, bx - (tw >> 1) - 1, by, C.trunk, t.x, t.z, 0, by, t.z, false, shape.cylinder(-0.9))
      this.put(B, bx + tw - (tw >> 1), by, C.trunk, t.x, t.z, 0, by, t.z, false, shape.cylinder(0.9))
    }
    if (branch && crown.includes(branch)) {
      // the branch: from the trunk out to its clump
      const y0 = Math.round(branch.cy + branch.ry * 0.3)
      const x1 = Math.round(branch.cx)
      const steps = Math.abs(x1 - bx)
      for (let i = 0; i <= steps; i++) {
        const px = bx + Math.sign(x1 - bx) * i
        const py = Math.round(y0 + (i / (steps || 1)) * -branch.ry * 0.3 + (1 - i / (steps || 1)) * R * 0.25)
        for (let j = 0; j < Math.max(1, tw >> 2); j++)
          this.put(B, px, py + j, C.trunk, t.x, t.z, (by - py) / ys, by, t.z, false, shape.flat, texAt('tree', 'trunk', px, py + j, t.seed), bark)
      }
    }
    this.foliage(B, crown, {
      surface: surf('tree', 'crown'),
      highlights: highlights('tree'),
      depth: DATA.families.tree?.depth,
      x: t.x,
      z: t.z,
      bx,
      by,
      s,
      dep: t.z + 0.002,
      base: t.tone > 0.5 ? C.canopy : C.canopyD,
      speck: C.canopyRim,
      dim: C.canopyHi,
      seed: t.seed,
      arcs: false,
      heightAt: (py) => (by - py) / ys,
    })
  }

  /**
   * The small things about the wood, each drawn at full resolution from its seed: ferns,
   * tall grass, foxgloves, mossy rocks, stumps, fallen logs, little mushroom clusters (some
   * of them faintly glowing, like the village's cousins).
   */
  private drawDetail(B: Buf, d: Detail) {
    const [bx, by, s] = project(d.x, 0, d.z)
    const rng = rngFrom(d.seed)
    const dep = d.z
    const plant = (px: number, py: number, c: Color, nrm: Normal = [0, 0.35, 0.94]) =>
      this.put(B, px, py, c, d.x + (px - bx) / s, d.z, (by - py) / s, by, dep, false, nrm)
    this.region++
    switch (d.kind) {
      case 'fern': {
        // fronds arching out from the middle, leaflets in pairs, lighter toward the tips
        const n = 5 + (d.seed % 3)
        const len = (4.2 + rng() * 1.8) * d.size * s
        for (let i = 0; i < n; i++) {
          const th = -1.2 + (2.4 * i) / (n - 1) + (rng() - 0.5) * 0.25
          const droop = 0.25 + Math.abs(th) * 0.35
          const steps = Math.round(len * 1.2)
          for (let k = 0; k <= steps; k++) {
            const u = k / steps
            const x = bx + Math.round(Math.sin(th) * len * u * (1 + 0.3 * u))
            const y = by - Math.round(Math.cos(th) * len * u - droop * len * u * u)
            const c = u > 0.7 ? C.fernHi : u < 0.2 ? C.fernD : C.fern
            plant(x, y, c)
            if (k % 2 === 0 && u > 0.12 && u < 0.95) {
              const leaf = u < 0.6 ? 2 : 1
              for (let j = 1; j <= leaf; j++) {
                plant(x - j, y - (j > 1 ? 1 : 0), c)
                plant(x + j, y - (j > 1 ? 1 : 0), c)
              }
            }
          }
        }
        break
      }
      case 'grass': {
        // a clump of tall blades, leaning, their tips paler
        const n = 7 + (d.seed % 5)
        for (let i = 0; i < n; i++) {
          const h = Math.round((2.6 + rng() * 3.2) * d.size * s)
          const lean = (rng() - 0.5) * 0.8
          const ox = Math.round((i - n / 2) * 1.3 + (rng() - 0.5) * 2)
          for (let j = 0; j < h; j++) plant(bx + ox + Math.round((lean * j * j) / h), by - j, j > h * 0.72 ? C.grassTip : j < h * 0.25 ? C.fernD : C.grassTall)
        }
        break
      }
      case 'foxglove': {
        // a few tall stalks of bells over a rosette of leaves
        for (let k = -3; k <= 3; k++) for (let j = 0; j < 2; j++) plant(bx + k, by - j, j ? C.fernHi : C.fern)
        const n = 1 + (d.seed % 3)
        for (let i = 0; i < n; i++) {
          const ox = (i - (n - 1) / 2) * 3
          const h = Math.round((6.5 + rng() * 3) * d.size * s)
          for (let j = 2; j < h; j++) {
            plant(bx + ox, by - j, C.fern)
            if (j > h * 0.35 && j % 2 === 0) {
              const side = (j >> 1) % 2 ? 1 : -1
              plant(bx + ox + side, by - j, C.foxglove)
              plant(bx + ox + side * 2, by - j, C.foxglove)
              plant(bx + ox + side, by - j + 1, C.foxgloveD)
            }
          }
          plant(bx + ox, by - h, C.foxglove)
        }
        break
      }
      case 'rock': {
        // a mossy stone, grainy, half sunk in the ground
        const rx = Math.max(3, Math.round(1.7 * d.size * s))
        const ry = Math.max(2, Math.round(rx * 0.62))
        disc(
          (px, py, u, v) => {
            let c = v < -0.35 && hash(px, py * 3) < 0.7 ? C.moss2 : hash(px * 3 + d.seed, py) < 0.3 ? C.stoneD : C.stone
            if (v < -0.1 && u < -0.3 && c !== C.moss2) c = C.stoneHi
            this.put(
              B,
              px,
              py,
              c,
              d.x + (px - bx) / s,
              d.z,
              (by - py) / s,
              by,
              dep,
              false,
              shape.dome(u, v),
              texAt('rock', 'stone', px, py, d.seed),
              surf('rock', 'stone').relief,
            )
          },
          bx,
          by - Math.round(ry * 0.55),
          rx,
          ry,
        )
        break
      }
      case 'stump': {
        // an old stump: bark sides, a pale cut top with rings, moss, roots
        const hw = Math.max(3, Math.round(1.3 * d.size * s))
        const ht = Math.round(1.3 * d.size * s)
        // seen from a little above, its bark sides come down in a curve toward us, below where it stands
        const fq = DATA.families.stump?.footprint ?? 0
        for (let k = -hw; k <= hw; k++) {
          const below = Math.round(fq * Math.sqrt(Math.max(0, hw * hw - k * k)))
          for (let r = -below; r < 0; r++) {
            const u = k / hw
            this.put(
              B,
              bx + k,
              by - r,
              u < -0.6 ? C.trunkRim : hash(k * 5, r * 3 + d.seed) < 0.3 ? C.stickD : C.log,
              d.x + k / s,
              d.z,
              0,
              by,
              dep,
              false,
              shape.cylinder(u),
              texAt('stump', 'bark', bx + k, by - r, d.seed),
              surf('stump', 'bark').relief,
            )
          }
        }
        for (let r = 0; r < ht; r++)
          for (let k = -hw; k <= hw; k++) {
            const u = k / hw
            const c = r < 2 && hash(k, r + d.seed) < 0.5 ? C.moss2 : u < -0.6 ? C.trunkRim : hash(k * 5, r * 3 + d.seed) < 0.3 ? C.stickD : C.log
            this.put(
              B,
              bx + k,
              by - r,
              c,
              d.x + k / s,
              d.z,
              r / s,
              by,
              dep,
              false,
              shape.cylinder(u),
              texAt('stump', 'bark', bx + k, by - r, d.seed),
              surf('stump', 'bark').relief,
            )
          }
        disc(
          (px, py, u, v) => {
            const ring = Math.hypot(u, v * 1.6)
            const c = ring > 0.85 ? C.stickD : Math.round(ring * 4) % 2 ? C.logEnd : C.logLit
            this.put(B, px, py, c, d.x + (px - bx) / s, d.z, ht / s, by, dep + 0.01, false, [0, 0.9, 0.44])
          },
          bx,
          by - ht,
          hw,
          Math.max(1, Math.round(hw * 0.4)),
        )
        for (const k of [-hw - 1, hw + 1, -hw - 2]) plant(bx + k, by, C.stickD)
        break
      }
      case 'log': {
        // a fallen log, moss along its back, its cut end to one side
        const half = Math.round(2.3 * d.size * s)
        const th = Math.max(3, Math.round(0.85 * d.size * s))
        const dir = d.seed % 2 ? 1 : -1
        for (let k = -half; k <= half; k++)
          for (let r = 0; r < th; r++) {
            const v = (r / (th - 1)) * 2 - 1 // top to bottom: -1 .. 1, as a dome across it
            let c = v < -0.5 && hash(k, d.seed + r) < 0.75 ? C.moss2 : v > 0.5 ? C.stickD : hash(k * 3, r * 5 + d.seed) < 0.25 ? C.stickD : C.log
            if (k * dir >= half - 1) c = Math.abs(v) < 0.4 ? C.logEnd : C.logLit // the cut end
            this.put(
              B,
              bx + k,
              by - th + 1 + r,
              c,
              d.x + k / s,
              d.z,
              (th - r) / s,
              by,
              dep,
              false,
              shape.dome(0, v),
              texAt('log', 'bark', bx + k, by - r, d.seed),
              surf('log', 'bark').relief,
            )
          }
        break
      }
      case 'mushrooms': {
        // three to five little mushrooms; some of them glow
        const n = 3 + (d.seed % 3)
        for (let i = 0; i < n; i++) {
          const ox = Math.round((rng() - 0.5) * 8 * d.size)
          const oz = rng() * 1.2
          const [mx, my] = project(d.x + ox / s, 0, d.z + oz)
          const h = 2 + ((rng() * 3) | 0)
          const w = 1 + ((rng() * 2) | 0)
          const glow = rng() < 0.45
          for (let j = 0; j < h; j++) this.put(B, mx, my - j, C.mushPale, d.x, d.z + oz, j / s, my, d.z + oz, false, shape.cylinder(0))
          for (let k = -w; k <= w; k++) {
            this.put(B, mx + k, my - h, glow ? C.mushPale : C.mushTan, d.x, d.z + oz, h / s, my, d.z + oz, false, shape.dome(k / (w + 1), -0.3))
            if (Math.abs(k) < w)
              this.put(B, mx + k, my - h - 1, glow ? C.mushPale : C.mushTan, d.x, d.z + oz, (h + 1) / s, my, d.z + oz, false, shape.dome(k / (w + 1), -0.8))
            if (glow) this.detailGlows.push({ x: mx + k, y: my - h - (Math.abs(k) < w ? 1 : 0), dep: d.z + oz + 0.01, ph: rng() * 6, tag: this.tag })
          }
        }
        break
      }
    }
  }

  /** A bush: a mound of overlapping lobes sitting on the ground, dotted along their rims. */
  private drawBush(B: Buf, b: Bush) {
    const [bx, by, s] = project(b.x, 0, b.z)
    const rng = rngFrom(b.seed)
    const wd = b.w * s
    const ht = b.h * s
    const lobes: Lobe[] = []
    // seen from a little above, its footprint is round: a back row sits higher, the front row
    // curves toward you (the middle nearest), and its bottom edge follows the footprint
    const deep = wd * 0.5 * (DATA.families.bush?.footprint ?? 0) // how far the front comes toward us, on screen
    let clipAt: ((px: number) => number) | undefined
    if (deep > 0.5) {
      for (const k of [-1, 1]) {
        const r = wd * (0.3 + rng() * 0.08)
        lobes.push({ cx: bx + k * wd * 0.32, cy: by - ht * 0.7 - deep * 0.6, rx: r, ry: r * 0.9 })
      }
      lobes.push({ cx: bx + (rng() - 0.5) * wd * 0.2, cy: by - ht * 0.85 - deep * 0.2, rx: wd * 0.45, ry: ht * 0.6 })
      for (let k = 0; k < b.lobes; k++) {
        const f = b.lobes > 1 ? k / (b.lobes - 1) - 0.5 : 0
        const r = wd * (0.4 + rng() * 0.14) * (1 - Math.abs(f) * 0.45)
        lobes.push({ cx: bx + f * wd * 1.1 + (rng() - 0.5) * wd * 0.1, cy: by - r * 0.6 + deep * (1 - 4 * f * f) * 0.7, rx: r, ry: r * 0.82 })
      }
      lobes.sort((a, b) => a.cy - b.cy) // nearer (lower) lobes draw over farther ones
      clipAt = (px) => by + deep * Math.sqrt(Math.max(0, 1 - ((px - bx) / (wd * 0.62)) ** 2))
    } else {
      // side on: the top of the mound first (behind), then the lower lobes in front of it
      lobes.push({ cx: bx + (rng() - 0.5) * wd * 0.3, cy: by - ht * 0.95, rx: wd * 0.5, ry: ht * 0.62 })
      for (let k = 0; k < b.lobes; k++) {
        const f = b.lobes > 1 ? k / (b.lobes - 1) - 0.5 : 0
        const r = wd * (0.42 + rng() * 0.16) * (1 - Math.abs(f) * 0.5)
        lobes.push({ cx: bx + f * wd * 1.15 + (rng() - 0.5) * wd * 0.12, cy: by - r * (0.55 + rng() * 0.2), rx: r, ry: r * 0.85 })
      }
    }
    this.foliage(B, lobes, {
      surface: surf('bush', 'leaves'),
      highlights: highlights('bush'),
      depth: DATA.families.bush?.depth,
      x: b.x,
      z: b.z,
      bx,
      by,
      s,
      dep: b.z,
      base: C.bush,
      speck: C.canopyRim,
      dim: C.canopyHi,
      seed: b.seed,
      arcs: true,
      clipY: clipAt ? by + deep + 1 : by,
      clipAt,
      heightAt: (py) => (by - py) / s,
    })
  }

  /**
   * A big mushroom house (HUT, prop data). Its doorway is set back behind the walls (the art's
   * `depth`), so shroomfolk walking in are hidden by the walls but stay visible through the open
   * door. The door itself, the lit window and the interior glow are dynamic.
   */
  private drawHut(B: Buf, hut: Point) {
    this.drawArtNow(B, HUT, hut.x, hut.z, {})
  }

  /** The knight's own sword, planted point-down beside him. */
  private drawSword(B: Buf, p: Point) {
    this.drawArt(B, SWORD, p.x, p.z)
  }

  private drawPack(B: Buf, p: Point) {
    this.drawArt(B, PACK, p.x, p.z)
  }

  private drawGrave(B: Buf, g: Point & { helm?: boolean }, i: number) {
    const [bx, by] = project(g.x, 0, g.z)
    const dep = g.z
    this.region++
    disc(
      (px, py, u, v) =>
        this.put(
          B,
          px,
          py,
          v < -0.2 && u < 0 ? C.stoneHi : hash(px, py) < 0.4 ? C.stoneD : C.stone,
          g.x,
          g.z,
          1 - v,
          by,
          dep,
          false,
          shape.dome(u, v),
          texAt('grave', 'stone', px, py, i),
          surf('grave', 'stone').relief,
        ),
      bx,
      by,
      3 * RES,
      RES,
    )
    // a rusted sword, tilted differently on each grave: a two-pixel blade, crossguard, grip, pommel
    const tilt = [-1, 0, 1][i % 3]
    const lean = (r: number) => Math.round((tilt * r) / 8)
    const put = (x: number, r: number, c: Color, n: Normal, mh = 0, mw = 0) =>
      this.put(B, bx + x, by - r, c, g.x, g.z, r / RES, by, dep + 0.1, false, n, mh, mw)
    this.region++
    for (let r = 2; r < 22; r++) {
      const rusty = hash(r * 3, i * 7) < 0.22
      put(lean(r), r, rusty ? C.rust : C.blade, [-0.5, 0, 0.87], rusty ? -0.5 : 0, 0.5)
      put(lean(r) + 1, r, rusty || hash(r, i) < 0.3 ? C.rust : C.bladeD, [0.5, 0, 0.87], 0, 0.5)
    }
    const tk = lean(22)
    for (let k = -4; k <= 5; k++) put(tk + k, 22, C.rust, [0, 0.5, 0.87])
    for (let k = -3; k <= 4; k++) put(tk + k, 23, k === -3 || k === 4 ? C.rust : C.grip, [0, -0.3, 0.95])
    for (let r = 24; r < 27; r++) put(tk + (r === 25 ? 1 : 0), r, C.grip, shape.cylinder(0))
    put(tk, 27, C.rust, [0, 0.7, 0.7])
    put(tk + 1, 27, C.rust, [0, 0.7, 0.7])
    if (g.helm) {
      this.region++
      disc(
        (px, py, u, v) => this.put(B, px, py, v < 0 && u < 0 ? C.stoneHi : C.helm, g.x, g.z, 14 - v, by, dep + 0.2, false, shape.dome(u, v), 0, WEIGHT.metal),
        bx + tk,
        by - 30,
        2 * RES,
        2 * RES,
      )
      for (let k = 1; k <= 3; k++) this.put(B, bx + tk + k, by - 30, C.door, g.x, g.z, 15, by, dep + 0.3, false, shape.flat) // visor slit
      this.put(B, bx + tk + 2, by - 28, C.door, g.x, g.z, 14, by, dep + 0.3, false, shape.flat)
    }
  }

  private drawLanternPost(B: Buf, p: Point) {
    this.drawArt(B, lanternCut().post, p.x, p.z) // the lantern itself is drawn with the moving things (it can be carried off)
  }

  /** Where the lantern was drawn this frame (screen bottom-centre, its ground line, depth), for its glow. */
  private lanternAt: { sx: number; sy: number; ground: number; dep: number } | null = null

  /** The lantern: on its post, in the visitor's hand (hanging from it), or set down somewhere. */
  private drawLantern(B: Buf, w: World) {
    const { lantern, dx, up } = lanternCut()
    const h = lantern.rows.length
    const hand = w.hand
    if (hand?.held?.kind === 'lantern') {
      const [hx, hy] = project(hand.x, hand.y, hand.z)
      const [, gy] = project(hand.x, 0, hand.z)
      this.lanternAt = { sx: Math.round(hx), sy: Math.round(hy) + h - 1, ground: gy, dep: hand.z + 0.6 }
    } else if (w.lantern.onPost) {
      const [lx, ly] = project(PROPS.lantern.x, 0, PROPS.lantern.z)
      this.lanternAt = { sx: Math.round(lx) + dx, sy: Math.round(ly) - up, ground: ly, dep: PROPS.lantern.z + 0.01 }
    } else {
      const [, gy] = project(w.lantern.x, 0, w.lantern.z)
      const [lx, ly] = project(w.lantern.x, w.lantern.y, w.lantern.z) // (falling, once let go)
      this.lanternAt = { sx: Math.round(lx), sy: Math.round(ly), ground: gy, dep: w.lantern.z }
    }
    const at = this.lanternAt
    const wx = hand?.held?.kind === 'lantern' ? hand.x : w.lantern.x
    const wz = hand?.held?.kind === 'lantern' ? hand.z : w.lantern.z
    // not a shadow caster: its own light is inside it (a caster is a flat cut-out standing at its foot)
    const lift = hand?.held?.kind === 'lantern' ? hand.y : w.lantern.onPost ? up / ZOOM : w.lantern.y
    this.drawArtNow(B, lantern, wx, wz, { at: [at.sx, at.sy], dep: at.dep, lift })
  }

  /** A single log, `height` above the ground (one set down by the visitor, or falling from their hand). */
  private drawLog(B: Buf, wx: number, wz: number, height: number) {
    const [bx, by] = project(wx, height, wz)
    this.drawArt(B, LOG, wx, wz, { at: [Math.round(bx), Math.round(by)], dep: wz + 0.6, lift: height })
  }

  /** What the visitor's hand holds (the lantern and shroomfolk are drawn with their own). */
  private drawHeld(B: Buf, w: World) {
    const hand = w.hand
    const held = hand?.held
    if (!hand || !held) return
    const [hx, hy] = project(hand.x, hand.y, hand.z)
    if (held.kind === 'log') this.drawArt(B, LOG, hand.x, hand.z, { at: [Math.round(hx), Math.round(hy) + 2], dep: hand.z + 0.6, lift: hand.y }) // held through its middle
    if (held.kind === 'stick') this.drawStick(B, hand.x, hand.z, 0, HELD_STICK, hand.y) // a little slanted, like a torch
  }

  /** The tip of a stick held upright at the hand (screen), where its flame burns. */
  private brandTip(w: World): [number, number, number] | null {
    const hand = w.hand
    const held = hand?.held
    if (!hand || held?.kind !== 'stick' || !held.lit) return null
    const [hx, hy] = project(hand.x, hand.y, hand.z)
    const [tx, ty] = stickTip(HELD_STICK)
    return [Math.round(hx) + tx, Math.round(hy) - 2 + ty, hand.z + 0.7]
  }

  /** A small flame (a burning stick's), flickering, at a screen point. */
  private smallFlame(x: number, y: number, dep: number, t: number, size: number) {
    const k = (n: number) => FLAME[Math.min(3, Math.max(0, n))]
    const sway = Math.sin(t * 11) > 0.3 ? 1 : 0
    const tall = size > 0.5 ? 2 : 1
    this.putFx(x, y, k(3), 0.95, undefined, dep, 0.9)
    this.putFx(x - 1, y, k(2), 0.8, undefined, dep, 0.8)
    this.putFx(x + 1, y, k(2), 0.8, undefined, dep, 0.8)
    for (let i = 1; i <= tall; i++) this.putFx(x + (i === tall ? sway : 0), y - i, k(2 - i + 1), 0.85, undefined, dep, 0.8)
    this.putFx(x + sway, y - tall - 1, k(0), 0.6, undefined, dep, 0.6)
  }

  /**
   * The trigon stone: a bevelled slab of grainy, pitted, rain-streaked stone with a triangle
   * cut into it. The cut is a groove (low micro height) so its lips catch the rune's light.
   */
  private drawTrigon(B: Buf, p: Point) {
    const [bx, by, s] = project(p.x, 0, p.z)
    const hgt = Math.round(40 * s)
    const wid = Math.round(7 * s)
    const hy = by - Math.round(hgt * 0.6)
    const carved = new Set(trigonPx.map(([dx, dy]) => `${dx},${dy}`))
    const inside = new Set(TRIGON_INSIDE.map(([dx, dy]) => `${dx},${dy}`))
    this.region++
    for (let r = 0; r < hgt; r++) {
      const taper = r > hgt - 4 * RES ? RES : 0
      for (let k = -wid + taper; k <= wid - taper; k++) {
        const px = bx + k
        const py = by - r
        let c = k < -wid + 2 * RES ? C.stoneHi : k > wid - 2 * RES ? C.stoneD : C.stone
        if (hash(k * 7, r * 3) < 0.08) c = C.stoneD
        if (hash(k, r) < 0.05 && r < hgt * 0.4) c = C.moss
        let mh = texAt('trigon', 'stone', px, py, 17)
        const cell = `${px - bx},${py - hy}`
        if (carved.has(cell)) {
          c = C.stoneD
          mh = -2.2 // the cut
        } else if (inside.has(cell)) mh -= 0.5 // the face inside the triangle sits a little lower
        this.put(B, px, py, c, p.x + k / s, p.z, r / s, by, p.z, false, shape.slab(k, wid, r, hgt), mh, surf('trigon', 'stone').relief)
      }
    }
  }

  /** A ring of stones around the fire: grainy domes. */
  private drawStoneRing(B: Buf) {
    for (const st of STONE_RING)
      this.casting(B, st.x, st.z, () => {
        const [sx, sy, s] = project(st.x, 0, st.z)
        this.region++
        disc(
          (px, py, u, v) => {
            let c = hash(px * 3 + st.seed, py) < 0.3 ? C.stoneD : C.stone
            if (v < -0.2 && u < 0.2) c = C.stoneHi
            if (v > 0.5) c = C.stoneD
            this.put(
              B,
              px,
              py,
              c,
              st.x + (px - sx) / s,
              st.z,
              (sy - py) / s + 0.5,
              sy,
              st.z,
              false,
              shape.dome(u, v),
              texAt('stoneRing', 'stones', px, py, st.seed),
              surf('stoneRing', 'stones').relief,
            )
          },
          sx,
          sy - Math.floor((st.h * RES) / 2),
          st.w * RES,
          Math.max(1, st.h) * RES,
        )
      })
  }

  /** Three old standing stones behind the fire: bevelled, pitted, mossy at the foot. */
  private drawHearthstones(B: Buf) {
    HEARTHSTONES.forEach((hs, idx) => this.casting(B, hs.x, hs.z, () => this.drawHearthstone(B, hs, idx)))
  }

  private drawHearthstone(B: Buf, hs: (typeof HEARTHSTONES)[number], idx: number) {
    {
      const prevTag = this.tag
      this.tag = tagId(`hearth${idx}`)
      const [bx, by, s] = project(hs.x, 0, hs.z)
      const hgt = Math.round(hs.h * s * 0.75)
      const cy = by - Math.round(hgt * 0.55)
      const carving = new Set(CROWN_PX.map(([dx, dy]) => `${dx},${dy}`))
      this.region++
      for (let r = 0; r < hgt; r++) {
        const lean = Math.round((hs.lean * RES * r) / hgt)
        const half = (r > hgt - 3 * RES ? hs.w - 1 : hs.w) * RES
        for (let k = -half; k <= half - 1; k++) {
          const px = bx + k + lean
          const py = by - r
          let c = k < -half + RES ? C.menhirHi : k >= half - RES ? C.menhirD : C.menhir
          if (hash(k * 5 + hs.x, r * 3) < 0.1) c = C.menhirD
          let mh = texAt('hearthstone', 'stone', px, py, hs.x)
          if (r < 3 * RES && hash(k, r + hs.z) < 0.5) {
            c = C.moss2
            mh += 0.6 // moss sits proud
          }
          if (hs.carved && carving.has(`${px - bx},${py - cy}`)) {
            c = C.menhirD
            mh = -2 // the carved crown
          }
          this.put(B, px, py, c, hs.x + k / s, hs.z, r / s, by, hs.z, false, shape.slab(k, half, r, hgt), mh, surf('hearthstone', 'stone').relief)
        }
      }
      this.tag = prevTag
    }
  }

  /**
   * The moon is a sky object: its face (a sphere's normals bumped by craters, its colour with
   * darker seas, and how much of each texel the disc covers) is built once in its own space, and
   * the compositor draws it every frame wherever it is, to a fraction of a pixel, lit by its own
   * sun (which lights nothing else). So it glides, its face stays put while the light on it turns,
   * clouds pass in front, and it slips behind the treeline and the stone.
   */
  private moonFace: MoonFace | null = null
  /** Its face for the current look (rebuilt when its texture changes). */
  private faceOfMoon(): MoonFace {
    const face = surf('moon', 'face')
    const key = `${face.texture}|${face.relief}`
    if (this.moonFace?.key === key) return this.moonFace
    const D = 2 * MOON_R + 3
    const c = (D - 1) / 2
    const R = MOON_R + 0.5
    const data = new Float32Array(D * D * 2 * 4)
    const bright = hex('#e9e3d4')
    const sea = hex('#8a8478')
    const h = (x: number, y: number) => textureAt(face.texture, x, y, 3)
    for (let j = 0; j < D; j++)
      for (let i = 0; i < D; i++) {
        const lx = i - c
        const ly = j - c
        // how much of this texel the disc covers (4x4 samples), for a soft edge as it glides
        let cover = 0
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (Math.hypot(lx + (sx + 0.5) / 4 - 0.5, ly + (sy + 0.5) / 4 - 0.5) <= R) cover++
        let u = lx / R
        let v = ly / R
        const rr = Math.hypot(u, v)
        if (rr > 0.98) ((u *= 0.98 / rr), (v *= 0.98 / rr))
        // the sphere, bumped by the craters (in the moon's own coordinates: the face doesn't slide)
        const dx = (h(lx + 1, ly) - h(lx - 1, ly)) * 0.5 * face.relief
        const dy = (h(lx, ly + 1) - h(lx, ly - 1)) * 0.5 * face.relief
        const n = unit(u - dx * 0.6, -v + dy * 0.6, Math.sqrt(Math.max(0, 1 - u * u - v * v)))
        // its colour: the darker seas, and the craters' floors darker and their rims paler (a full moon reads by these)
        const seas = mix(sea, bright, clamp(0.05 + vnoise(lx * 0.12 + 45, ly * 0.12 + 20) * 1.25))
        const albedo = seas.map((v) => v * (1 + 0.28 * h(lx, ly))) as Color
        data.set([n[0], n[1], n[2], cover / 16], (j * D + i) * 4)
        // and the craters alone (not the ball) under a low light from the upper left: how much each texel
        // brightens or darkens for its bump (moonLit uses it near full, when its own sun lights them all alike)
        const ball = unit(u, -v, Math.sqrt(Math.max(0, 1 - u * u - v * v)))
        const bump = dot3(n, RELIEF_LIGHT) - dot3(ball, RELIEF_LIGHT)
        data.set([albedo[0], albedo[1], albedo[2], bump], ((j + D) * D + i) * 4)
      }
    return (this.moonFace = { key, size: D, data, version: (this.moonFace?.version ?? 0) + 1 })
  }
  /** Sample the moon's face at screen pixel (x, y) (bilinear, so it moves smoothly): into out = normal xyz, cover, albedo rgb, crater bump. False if it isn't there. */
  private sampleMoon(x: number, y: number, out: Float32Array): boolean {
    const F = this.moonFace
    if (!F || !MOON_DISC.up) return false
    const D = F.size
    const fx = x - (MOON_DISC.x - (D - 1) / 2)
    const fy = y - (MOON_DISC.y - (D - 1) / 2)
    if (fx <= -1 || fy <= -1 || fx >= D || fy >= D) return false
    const i0 = Math.floor(fx)
    const j0 = Math.floor(fy)
    const tx = fx - i0
    const ty = fy - j0
    out.fill(0)
    for (const [di, dj, wgt] of [
      [0, 0, (1 - tx) * (1 - ty)],
      [1, 0, tx * (1 - ty)],
      [0, 1, (1 - tx) * ty],
      [1, 1, tx * ty],
    ]) {
      const i = i0 + di
      const j = j0 + dj
      if (i < 0 || j < 0 || i >= D || j >= D || wgt === 0) continue
      const o = (j * D + i) * 4
      const a = ((j + D) * D + i) * 4
      for (let k = 0; k < 4; k++) out[k] += F.data[o + k] * wgt
      for (let k = 0; k < 4; k++) out[4 + k] += F.data[a + k] * wgt
    }
    if (out[3] <= 0.001) return false
    const l = Math.hypot(out[0], out[1], out[2]) || 1
    out[0] /= l
    out[1] /= l
    out[2] /= l
    return true
  }
  /** The moon's own sun this frame (toward it) and how much of its dark side shows. */
  private moonSun: [number, number, number] = [0, 0, 1]
  private earthshine = 0.02
  /** Where the moon is this frame. */
  private moonAt: MoonPlace | null = null

  /** The moon's clock this frame: where it is, its sun, and the stone turning it and the hush while it's gone. */
  private tickMoon(w: World) {
    const at = (this.moonAt = moonPlace(w.moon))
    // while it's behind the stone: the stone turns it (its carving glows up and fades), and the
    // forest is hushed (eases in, and out again as the moon comes back up)
    const { crossing } = moonTiming()
    const smooth = (v: number) => v * v * (3 - 2 * v)
    const h = w.moon.t - crossing
    this.hush = h >= 0 ? smooth(clamp(h / 4)) : 1 - smooth(clamp(w.moon.t / 8))
    this.turning = h >= 0 && h < 10 ? Math.sin((Math.PI * h) / 10) : 0
    MOON_DISC.x = at.x
    MOON_DISC.y = at.y
    MOON_DISC.up = at.up
    this.faceOfMoon()
    const ph = (at.phase * Math.PI) / 180
    const an = (at.angle * Math.PI) / 180
    this.moonSun = [Math.cos(an) * Math.sin(ph), Math.sin(an) * Math.sin(ph), Math.cos(ph)]
    this.earthshine = DATA.families.moon?.sun?.earthshine ?? 0.02
    this.fullRelief = DATA.families.moon?.sun?.fullRelief ?? FULL_RELIEF
  }
  /** How much the craters keep their shading near full (families data). */
  private fullRelief = FULL_RELIEF
  /** Light a sampled moon pixel by its sun: how far from the sky behind it toward its face (0..1), banded like the rest of the light. */
  private moonLit(m: Float32Array): number {
    const S = this.moonSun
    const lit = Math.max(0, m[0] * S[0] + m[1] * S[1] + m[2] * S[2])
    // it stays bright right up to its terminator (it isn't a matte ball); the dark side only a hint lighter than the sky
    const band = Math.round(Math.min(1, lit * 2.6) * 4) / 4
    return (this.earthshine + (1 - this.earthshine) * band * this.craters(m[7])) * m[3]
  }
  /** Near full, the craters keep their shading from a low light (it fades out as the real sun moves round and shades them itself). */
  private craters(bump: number): number {
    const z = this.moonSun[2]
    return Math.min(1.3, Math.max(0.4, 1 + this.fullRelief * bump * z * z))
  }
  /** The hush while the moon is gone (0..1): the stars swell, the forest's own lights glow brighter. */
  private hush = 0
  /** The stone turning the moon (0..1): its carving glows. */
  private turning = 0
  /** How brightly the stone's carving glows: in the rain, or while it turns the moon. */
  private runeOf = (w: World) => Math.max(w.rune, 0.9 * this.turning)

  private buildStatic() {
    const B = this.st
    this.stillChanged = this.uploadAll = true
    const ridgeFar = C.ridgeFar
    const ridgeMid = C.ridgeMid
    this.baked = true
    this.poolLevel = -1 // recolour the pool after
    for (const k in B) (B[k as keyof Buf] as Float32Array).fill(0)
    B.dep.fill(SKY_DEPTH)
    B.rdep.fill(SKY_DEPTH)
    this.detailGlows = []
    this.shadows.statics = []
    this.shadows.version++
    this.region = 0
    const setBg = (x: number, y: number, c: Color, open = 0) => {
      if (x < 0 || x >= W || y < 0 || y >= H) return
      const i = y * W + x
      B.bgr[i] = c[0]
      B.bgg[i] = c[1]
      B.bgb[i] = c[2]
      B.sky[i] = open
    }
    // sky, crescent moon, far ridge, distant tree silhouettes standing on the horizon
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setBg(x, y, skyAt(y), 1)
    // two farther treelines, paler with distance: rounded crowns in the haze
    for (const [n, hi, rad, col, seed] of [
      [70, 26, 7, ridgeFar, 31],
      [55, 16, 5, ridgeMid, 32],
    ] as [number, number, number, Color, number][]) {
      const rr = rngFrom(seed)
      for (let i = 0; i < n; i++) {
        const x = rr() * W
        const cy = HORIZON - (4 + rr() * hi) * RES
        const rd = (2 + rr() * rad) * RES
        disc((px, py) => py <= HORIZON && setBg(px, py, col), x | 0, cy | 0, rd | 0, (rd * 1.15) | 0)
        for (let y = cy | 0; y <= HORIZON; y++) for (let k = -RES; k <= RES; k++) setBg((x | 0) + k, y, col)
      }
      for (let x = 0; x < W; x++) for (let y = HORIZON - 3 * RES; y <= HORIZON; y++) setBg(x, y, col)
    }
    for (let x = 0; x < W; x++) {
      const top = HORIZON - (6 + vnoise((x / RES) * 0.03, 4) * 16) * RES
      for (let y = top | 0; y <= HORIZON; y++) setBg(x, y, mix(hex('#121a27'), hex('#1b2535'), (y - top) / (22 * RES)))
    }
    const r = rngFrom(3)
    for (let i = 0; i < 40; i++) {
      const x = (r() * W) | 0
      const top = ((r() * 40) | 0) * RES
      const w = (1 + ((r() * 2) | 0)) * RES
      const col = hex('#0e1522')
      if (x > 126 * RES && x < 194 * RES) continue
      for (let y = top; y <= HORIZON; y++) for (let k = 0; k < w; k++) setBg(x + k, y, col)
      for (let j = 0; j < 4; j++) {
        const cy = top + (j * 7 + r() * 4) * RES
        const rad = ((2 + r() * 3) | 0) * RES
        disc((px, py) => setBg(px, py, col), x, cy | 0, rad, rad + RES)
      }
    }
    // ground
    for (let y = HORIZON + 1; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const [gx, gz] = unproject(x, y)!
        const c = this.groundCol(gx, gz)
        B.r[i] = c[0]
        B.g[i] = c[1]
        B.b[i] = c[2]
        B.a[i] = 1
        B.kx[i] = gx
        B.kz[i] = gz
        B.ky[i] = 0
        B.dep[i] = GROUND_DEPTH
        // reflections are baked into everywhere the pool can ever reach; fillPool() then marks
        // just what's under water at the moment
        if (inPool(gx, gz, POOL_MAX)) B.pool[i] = 1
      }
    }
    // everything that stands up, back to front
    const statics: { z: number; draw: () => void }[] = [
      ...TREES.map((t, i) => ({ z: t.z, draw: () => this.tagged(`tree${i}`, () => this.casting(B, t.x, t.z, () => this.drawTree(B, t))) })),
      ...BUSHES.map((b, i) => ({ z: b.z, draw: () => this.tagged(`bush${i}`, () => this.casting(B, b.x, b.z, () => this.drawBush(B, b))) })),
      ...UNDERGROWTH.map((b) => ({ z: b.z, draw: () => this.tagged('undergrowth', () => this.drawBush(B, b)) })),
      ...DETAILS.map((d, i) => ({ z: d.z, draw: () => this.tagged(`detail${i}`, () => this.casting(B, d.x, d.z, () => this.drawDetail(B, d))) })),
      ...PROPS.huts.map((h, i) => ({ z: h.z, draw: () => this.tagged(`hut${i}`, () => this.casting(B, h.x, h.z, () => this.drawHut(B, h))) })),
      ...PROPS.graves.map((g, i) => ({ z: g.z, draw: () => this.tagged('grove', () => this.casting(B, g.x, g.z, () => this.drawGrave(B, g, i))) })),
      { z: PROPS.lantern.z, draw: () => this.tagged('lanternpost', () => this.drawLanternPost(B, PROPS.lantern)) },
      { z: PROPS.trigon.z, draw: () => this.tagged('trigon', () => this.casting(B, PROPS.trigon.x, PROPS.trigon.z, () => this.drawTrigon(B, PROPS.trigon))) },
      { z: PROPS.pack.z, draw: () => this.tagged('pack', () => this.drawPack(B, PROPS.pack)) },
      ...this.seatLogStatic(B),
      { z: -13, draw: () => this.drawHearthstones(B) },
      { z: 0, draw: () => this.tagged('fire', () => this.drawStoneRing(B)) },
    ]
    for (const s of statics.sort((a, b) => a.z - b.z)) s.draw()
    // small things without normals of their own
    this.region = 0
    for (const t of TUFTS) if (!EDGE_TUFTS.includes(t)) this.drawTuft(B, t)
    for (const rd of REEDS) if (!EDGE_REEDS.includes(rd)) this.drawReed(B, rd)
    // Normals for every static object. Most props were drawn from primitives that know their
    // own shape normal; anything that wasn't gets one from the relief generator (normals.ts).
    // Then the material layer bakes micro detail (grain, pits, grooves, carvings) on top.
    const light = new Float32Array(N)
    const reliefRegion = new Int32Array(N)
    for (let i = 0; i < N; i++) {
      if (!B.id[i]) continue
      light[i] = lightness(B.r[i], B.g[i], B.b[i])
      if (B.nz[i] === 0) reliefRegion[i] = B.id[i]
    }
    const rx = new Float32Array(N)
    const ry = new Float32Array(N)
    const rz = new Float32Array(N)
    reliefNormals(W, H, reliefRegion, light, rx, ry, rz)
    for (let i = 0; i < N; i++) {
      if (!reliefRegion[i]) continue
      B.nx[i] = rx[i]
      B.ny[i] = ry[i]
      B.nz[i] = rz[i]
    }
    bakeMicroDetail(B)
    this.findPoolZone()
  }

  /** A tuft of grass, now and then with a flower (no normals of its own). */
  private drawTuft(B: Buf, t: (typeof TUFTS)[number]) {
    const [sx, sy] = project(t.x, 0, t.z)
    for (let k = 0; k < t.n; k++) {
      const hgt = 1 + (((t.s * 7 + k) % 3) | 0)
      for (let j = 0; j < hgt * RES; j++) this.put(B, sx + (k * 2 - t.n) * RES, sy - j, C.tuft, t.x, t.z, j / RES, sy, t.z)
    }
    if (t.flower) {
      for (let j = 0; j < 5; j++) this.put(B, sx, sy - j, C.tuft, t.x, t.z, j / RES, sy, t.z)
      for (const [dx, dy] of [
        [0, -7],
        [-1, -6],
        [1, -6],
        [0, -5],
      ])
        this.put(B, sx + dx, sy + dy, C.flower, t.x, t.z, 3, sy, t.z)
    }
  }

  /** A reed at the pool's edge, some with a cattail. */
  private drawReed(B: Buf, rd: (typeof REEDS)[number]) {
    const [sx, sy] = project(rd.x, 0, rd.z)
    for (let j = 0; j < rd.h * RES; j++) this.put(B, sx, sy - j, j >= (rd.h - 1) * RES ? C.reedHi : C.reed, rd.x, rd.z, j / RES, sy, rd.z)
    if (rd.s < 0.4) {
      for (let j = 1; j <= 5; j++) for (let k = 0; k < 2; k++) this.put(B, sx + k, sy - rd.h * RES + j, C.cattail, rd.x, rd.z, rd.h, sy, rd.z)
    }
  }

  /** A lily pad lies flat on the water: it blocks reflections and casts none. */
  private drawPad(B: Buf, x: number, z: number) {
    const [sx, sy] = project(x, 0, z)
    disc(
      (px, py, u, v) => {
        if (u > 0.25 && Math.abs(v) < 0.5) return // the notch
        this.put(B, px, py, v > 0.5 || u > 0.8 ? C.frogD : C.pad, x, z, 0.2, sy, z - 0.3, true)
      },
      sx,
      sy - 1,
      5,
      2,
    )
  }

  /** The pool's edge at its current level: pads on the water, the tufts and reeds it hasn't swallowed. */
  private drawPoolEdge(B: Buf, lvl: number) {
    for (const [x, z] of PADS) if (inPool(x, z, lvl)) this.drawPad(B, x, z)
    for (const t of EDGE_TUFTS) if (!inPool(t.x, t.z, lvl * 1.2)) this.drawTuft(B, t)
    for (const rd of EDGE_REEDS) if (!inPool(rd.x, rd.z, lvl * 0.98)) this.drawReed(B, rd)
  }

  /**
   * Fill the pool to `lvl`: which ground pixels are under water, which are its wet shore, and
   * which are dry. Only the pool's region is touched, so the rain can raise it every frame.
   */
  private fillPool(lvl: number) {
    const B = this.st
    this.stillChanged = this.uploadAll = true
    const Z = this.poolZone
    const wet = lvl * lvl
    const shore = (lvl * 1.16) ** 2
    for (let k = 0; k < Z.idx.length; k++) {
      const i = Z.idx[k]
      const m = Z.metric[k]
      B.pool[i] = m < wet ? 1 : 0
      if (Z.covered[k]) continue
      const c = m < wet ? C.water : m < shore ? C.shore : null
      B.r[i] = c ? c[0] : Z.dry[k * 3]
      B.g[i] = c ? c[1] : Z.dry[k * 3 + 1]
      B.b[i] = c ? c[2] : Z.dry[k * 3 + 2]
    }
    this.poolLevel = lvl
  }

  /** Remember the ground the pool can reach (after the static layer is drawn). */
  private findPoolZone() {
    const B = this.st
    const reach = (POOL_MAX * 1.16) ** 2
    const idx: number[] = []
    const metric: number[] = []
    for (let i = (HORIZON + 1) * W; i < N; i++) {
      const m = poolMetric(B.kx[i], B.kz[i])
      if (m >= reach) continue
      idx.push(i)
      metric.push(m)
    }
    const Z = { idx: Int32Array.from(idx), metric: Float32Array.from(metric), covered: new Uint8Array(idx.length), dry: new Float32Array(idx.length * 3) }
    idx.forEach((i, k) => {
      // something stands over this pixel (its colour isn't the ground's): leave its colour alone
      Z.covered[k] = B.dep[i] === GROUND_DEPTH ? 0 : 1
      const [gx, gz] = unproject(i % W, (i / W) | 0)!
      const c = this.groundCol(gx, gz)
      Z.dry.set(c, k * 3)
    })
    this.poolZone = Z
  }

  // ---------------------------------------------------------------- dynamic layer

  /** A campfire on the ground: an ash bed with a few bones, logs leaning in. Returns the flame's base. */
  private drawCampfire(B: Buf, w: World): [number, number] {
    const [fx, fy] = project(0, 0, 0)
    const heat = w.fire.heat
    // the ash bed lies flat (no reflection, no normals)
    disc(
      (px, py) => this.put(B, px, py, hash(px * 7, py * 3) < 0.35 ? C.ashD : C.ash, (px - fx) / (1.35 * RES), (py - fy) / (0.6 * RES), 0.1, fy, -0.6, true),
      fx,
      fy,
      7 * RES,
      2 * RES,
    )
    // a few bones scattered in the ash, and a little skull at its edge
    for (const [dx, dy] of [
      [-12, 0],
      [9, 2],
      [-6, 2],
      [11, -2],
    ]) {
      for (let k = 0; k < 4; k++) this.put(B, fx + dx + k, fy + dy, k === 0 || k === 3 ? C.boneD : C.bone, (dx + k) / 2.7, dy, 0.3, fy, -0.5, true)
      this.put(B, fx + dx, fy + dy - 1, C.bone, dx / 2.7, dy, 0.4, fy, -0.5, true)
      this.put(B, fx + dx + 3, fy + dy + 1, C.boneD, (dx + 3) / 2.7, dy, 0.2, fy, -0.5, true)
    }
    this.drawArt(B, SKULL, -3.5, 0, { at: [fx - 9, fy + 1], dep: -0.4 })
    // logs leaning into the middle, charred toward the heart of the fire
    const logs: [number, number, number, number][] = [
      [-14, 2, -2, -6],
      [14, 2, 2, -6],
      [-8, 4, 2, -4],
      [8, 4, -2, -4],
    ]
    for (const [x0, y0, x1, y1] of logs) {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const px = Math.round(x0 + (x1 - x0) * t)
        const py = Math.round(y0 + (y1 - y0) * t)
        for (let j = 0; j < 2; j++) {
          const c = t > 0.6 ? C.char : t > 0.3 || j === 1 ? C.log : C.logLit
          this.put(B, fx + px, fy + py + j, c, px / 2.7, 0.2, (-py - j) / RES + 1, fy, 0.05)
          if (t > 0.55 && hash(px * 3 + j, py + ((w.t * 3) | 0)) < 0.5) this.putFx(fx + px, fy + py + j, GLOW.ember, 0.4 + 0.6 * heat, fy, 0.06, 0.4)
        }
      }
    }
    return [fx, fy - 3 * RES]
  }

  private drawWoodpile(B: Buf, n: number) {
    const p = PROPS.woodpile
    const [bx, by] = project(p.x, 0, p.z)
    const slots = [
      [-4, 0],
      [0, 0],
      [4, 0],
      [-2, 2],
      [2, 2],
      [0, 4],
      [-6, 0],
      [6, 0],
      [4, 2],
    ]
    for (let i = 0; i < n; i++) {
      const [ox, oy] = slots[i]
      this.drawArt(B, LOG, p.x + ox / 1.35, p.z, { at: [bx + ox * RES, by - oy * RES], dep: p.z + 0.001 * oy })
    }
  }

  /** A stick: lying flat, carried, or tumbling through the air (`height` above the ground, `angle` of its spin). */
  private drawStick(B: Buf, wx: number, wz: number, lift: number, angle = 0, height = 0) {
    const [bx, by] = project(wx, height, wz)
    const [, gy] = project(wx, 0, wz)
    const cy = by - Math.round(lift * RES) - 1
    for (const [dx, dy, ch] of stickPixels(angle))
      this.put(B, bx + dx, cy + dy, STICK.pal[ch], wx, wz, height + lift - dy / RES, gy, wz + 0.6, false, shape.cylinder(0))
  }

  /** Closed: a plank door with iron bands and a brass ring. Open: nothing, so the dark interior (and anyone passing through) shows. */
  private drawHutDoor(B: Buf, hut: Point, open: boolean) {
    if (open) return
    const [bx, by] = project(hut.x, 0, hut.z)
    const { k0, r0 } = hutOpenings()
    const { rows, pal, parts, shine } = HUT_DOOR
    // its parts (if it has any) give it normals, and its texture (planks) with them
    const nm = parts.length ? partNormals(rows, parts, pal) : null
    rows.forEach((row, i) =>
      [...row].forEach((ch, c) => {
        if (ch === '.') return
        const k = k0 + c
        const r = r0 + rows.length - 1 - i
        const src = nm ? (i + 2) * nm.w + c + 2 : 0
        const nrm: Normal | undefined = nm ? [nm.nx[src], nm.ny[src], nm.nz[src]] : undefined
        this.put(B, bx + k, by - r, pal[ch], hut.x, hut.z, r / RES, by, hut.z + 0.005, false, nrm, 0, 0, shine?.[ch] ?? 0) // its iron can gleam
      }),
    )
  }

  private mushHover(m: Mush, w: World): [string, string] {
    const st = m.fsm.state
    if (st === 'sprouting') return [m.name, 'a sprout, new since the rain']
    let words = STATE_WORDS[st] ?? ''
    if (st === 'visit' && m.spot !== null && w.memorials[m.spot]) words = `sitting by ${w.memorials[m.spot].name}'s glowcap`
    const name = w.keeperId === m.id ? `${m.name}, the keeper` : isElder(m) && st !== 'departing' && st !== 'wilting' ? `old ${m.name}` : m.name
    return [name, words]
  }

  /** The knight, as far along his story as he is. */
  private drawKnight(B: Buf, w: World) {
    const k = w.knight
    const st = k.fsm.state
    const sitting = st === 'resting' || st === 'nodding' || st === 'tending'
    // seated, he holds his sword (it's in his sprite); it stays planted there when he gets up
    if (k.sword === 'planted' && !sitting) {
      this.tagged('sword', () => this.drawSword(B, PROPS.sword))
      this.say('sword', 'his sword', 'he has not drawn it in a long time')
    }
    if (k.sword === 'laid') {
      // his grave, beside his companions': a cairn, his sword planted, his helm on the hilt
      this.tagged('knightgrave', () => this.drawGrave(B, { ...KNIGHT_GRAVE, helm: true }, 1))
      this.say('knightgrave', 'the last knight', 'he rests with them now')
    }
    if (st === 'gone') return
    const sub: Record<string, string> = {
      resting: 'keeping his vigil',
      nodding: 'nodding off',
      tending: 'tending the fire',
      rising: 'rising, slowly',
      walking: 'walking to the quiet grove',
      kneeling: 'laying down his sword',
    }
    const opts = { hover: { key: 'knight', name: 'the last knight', sub: sub[st] }, shine: KNIGHT_SHINE, parts: KNIGHT_PARTS }
    if (sitting) {
      // tending the fire: he reaches to the pile, lifts a log, throws it
      const t = k.fsm.time
      const tend = t < TOSS.take ? KNIGHT_TOSS.reach : t < TOSS.throw ? KNIGHT_TOSS.lift : KNIGHT_TOSS.throw
      const rows = st === 'tending' ? tend : st === 'nodding' && k.headDown ? KNIGHT_NOD : KNIGHT
      this.sprite(B, rows, k.x, k.z, KNIGHT_PAL, false, opts)
    } else if (st === 'kneeling') this.sprite(B, KNIGHT_KNEEL, k.x, k.z, KNIGHT_PAL, false, opts)
    else this.sprite(B, st === 'walking' ? KNIGHT_STAND[((k.step * 3) % 2) | 0] : KNIGHT_STAND[0], k.x, k.z, KNIGHT_PAL, k.flip, opts)
  }

  /** The knight's log, once it exists and has a place: drawn with the still scene, behind him. */
  private seatLogStatic(B: Buf): { z: number; draw: () => void }[] {
    const art = seatLog()
    const p = PROPS.seatLog
    if (!art || !p) return []
    return [{ z: p.z, draw: () => this.tagged('seatlog', () => this.drawArt(B, art, p.x, p.z)) }]
  }

  /**
   * The relic planted in the middle of the fire: an object like the others, so every light (the
   * fire round it, the moon over it) lights it through its normals. Those come from its parts, or
   * if it has none, rounded from its silhouette, so each tine reads as a little round bone.
   */
  private drawRelic(B: Buf, fireX: number, groundY: number) {
    // it's drawn at the fire's middle (so the flame sheets wrap it), but lit as if it stood a little
    // behind the fire's light: the flames in front of it light its face, as they would
    const RELIC_LIGHT_Z = -1.5
    const art = RELIC_ART[this.relic]
    const h = art.rows.length
    const wd = art.rows[0].length
    const s = project(0, 0, 0)[2]
    const nm = art.parts.length ? partNormals(art.rows, art.parts, art.pal) : spriteNormals(art.rows, (ch) => art.pal[ch])
    art.rows.forEach((row, r) =>
      [...row].forEach((ch, c) => {
        if (ch === '.') return
        const k = c - (wd >> 1)
        const src = (r + 2) * nm.w + c + 2
        this.put(
          B,
          fireX + k,
          groundY + r - h,
          art.pal[ch],
          k / s,
          RELIC_LIGHT_Z,
          (h - r) / s,
          groundY,
          0,
          false,
          [nm.nx[src], nm.ny[src], nm.nz[src]],
          0,
          0,
          art.shine[ch] ?? 0,
        )
      }),
    )
  }

  /** Which frame a shroomfolk shows: walking, standing, or sitting (with the occasional blink). */
  private mushFrame(m: Mush, w: World, keeper: boolean): Rows {
    const set = keeper ? MUSH_KEEPER : isElder(m) ? MUSH.elder : MUSH
    const st = m.fsm.state
    const moving = WALKING.includes(st) && isMoving(m)
    if (moving) return set.walk[((w.t * (isElder(m) ? 5 : 7)) % 2) | 0]
    if (st === 'dance') return set.walk[((w.t * 6 + m.seed * 3) % 2) | 0] // stepping in time
    if (st === 'carried') return set.walk[((w.t * 9) % 2) | 0] // legs kicking in the air
    if (SITTING.includes(st)) return (w.t * 0.8 + m.seed * 7) % 3.5 < 0.15 ? set.sitBlink : set.sit
    return set.walk[0]
  }

  private drawDynamic(w: World) {
    const t = w.t
    const B = this.fb
    this.tickMoon(w)
    /** The forest's own lights (caps, glowcaps, foxfire, fireflies) glow brighter in the hush. */
    const glow = 1 + 0.7 * this.hush
    // back to the still scene, and an empty emissive layer: everywhere if the still layer changed,
    // otherwise only the bands of rows last frame's moving things touched
    if (this.stillChanged) {
      copyBuf(B, this.st)
      for (const k in this.fx) this.fx[k as keyof typeof this.fx].fill(0)
      this.fx.dep.fill(SKY_DEPTH)
      this.fx.rdep.fill(SKY_DEPTH)
      this.stillChanged = false
    } else {
      copyBands(B as never, this.st as never, this.touched)
      copyBands(this.fx as never, this.fxEmpty as never, this.touched)
    }
    // what last frame touched still has to reach the GPU this frame (it's been put back)
    this.touchedBefore.set(this.touched)
    this.touched.fill(0)
    this.frameNo++
    this.shadows.dynamics = []
    this.labels.clear()
    this.tag = 0
    this.region = 0
    this.drawPoolEdge(B, w.poolLevel)

    // names for the static props (their pixels were tagged when the static layer was built)
    PROPS.huts.forEach((_, i) => {
      const sleepers = w.mush.filter((m) => m.fsm.state === 'asleep' && m.hut === i).map((m) => m.name)
      const sub = sleepers.length ? `${sleepers.join(' and ')} asleep inside` : doorOpen(w, i) ? 'someone is stepping through the door' : 'empty for now'
      this.say(`hut${i}`, 'shroomfolk hollow', sub)
    })
    this.say('lanternpost', 'the road out', w.lantern.onPost ? 'someone keeps the lantern lit' : 'its lantern has wandered off')
    this.say(
      'lantern',
      'the lantern',
      w.hand?.held?.kind === 'lantern' ? 'warm in your hand' : w.lantern.onPost ? 'it lights the road out' : 'set down in the grass, still burning',
    )
    w.brands.forEach((b, i) => this.say(`brand${i}`, 'a burning stick', b.burn > 20 ? 'it will burn a while yet' : 'nearly out'))
    this.say('trigon', 'the trigon stone', this.turning > 0.05 ? 'it is turning the moon' : w.rune > 0.1 ? 'it hums in the rain' : 'cold and quiet')
    this.say('pack', 'his pack', w.knight.fsm.state === 'gone' ? 'left by the fire; nobody has moved it' : 'everything he still owns')
    // the hearthstones: whichever is carved says so; the others are just old
    const plain = ['older than the village', 'the tallest of them, and the oldest', 'it leans, as if listening']
    HEARTHSTONES.forEach((hs, i) =>
      hs.carved
        ? this.say(
            `hearth${i}`,
            'the carved hearthstone',
            w.fire.heat > 0.55 ? 'its crown glows when the fire is high' : 'an antler crown, cut deep, like the one in the fire',
            true,
          )
        : this.say(`hearth${i}`, 'a hearthstone', plain[i] ?? 'cold and old', true),
    )
    {
      const companions = w.knight.fsm.state === 'gone' ? 'the knight and his companions' : "the knight's companions"
      const village = w.memorials.length ? `, and ${w.memorials.length} of the village` : ''
      const candles = w.candles.some((c) => c.lit) ? '' : ' · the candles are out'
      this.say('grove', 'the quiet grove', `${companions}${village}${candles}`)
    }
    this.say('fire', 'the campfire', FIRE_WORDS[w.fire.fsm.state])
    this.say('woodpile', 'woodpile', `${w.pile} log${w.pile === 1 ? '' : 's'}, stacked by small hands`)
    this.say('pool', 'rain pool', w.poolLevel > 1.08 ? 'swollen with rain' : 'still and dark')
    this.say('foxfire', 'foxfire', 'a fungus that glows on rotting wood')
    this.say('relic', RELICS[this.relic].name, RELICS[this.relic].sub)
    BUSHES.forEach((b, i) => this.say(`bush${i}`, ...BUSH_NAMES[b.seed % BUSH_NAMES.length]))
    DETAILS.forEach((d, i) => this.say(`detail${i}`, ...DETAIL_NAMES[d.kind]))
    this.say('undergrowth', 'the deep wood', 'it goes on further than anyone has walked')
    this.say('owl', 'an owl', w.owl.away > 0 ? 'looking off into the dark' : 'it watches the fire with you')
    this.say('fardeer', elk() ? 'an elk, far off' : 'a deer, far off', 'crossing the back of the wood')
    this.say('bats', 'bats', 'out hunting moths')

    // ---- objects first (they fill the depth buffer that emissives test against)
    const [fireX, fireY] = this.tagged('fire', () => this.drawCampfire(B, w))
    const [, groundY] = project(0, 0, 0)
    this.tagged('relic', () => this.drawRelic(B, fireX, groundY))
    this.tagged('woodpile', () => this.drawWoodpile(B, w.pile))
    const held = w.hand?.held
    this.heldKey = held?.kind === 'lantern' ? 'lantern' : held?.kind === 'folk' ? `mush${held.id}` : null
    this.tagged('lantern', () => this.drawLantern(B, w))
    w.brands.forEach((b, i) => this.tagged(`brand${i}`, () => this.drawStick(B, b.x, b.z, 0, 0.35 + i, b.y)))
    this.tagged('held', () => this.drawHeld(B, w))
    for (const l of w.tossed) this.tagged('woodpile', () => this.drawStick(B, l.x, l.z, 0, l.angle, l.y)) // the knight's log, on its way to the fire
    this.drawKnight(B, w)
    w.sticks.forEach((s, i) => {
      this.say(`stick${i}`, 'a stick', s.landed ? (s.claimed ? 'someone is coming for it' : 'waiting to be fetched') : 'falling')
      this.tagged(`stick${i}`, () => (s.log ? this.drawLog(B, s.x, s.z, s.y) : this.drawStick(B, s.x, s.z, 0, s.angle, s.y)))
    })
    PROPS.huts.forEach((hut, i) => this.tagged(`hut${i}`, () => this.drawHutDoor(B, hut, doorOpen(w, i))))
    this.tagged('grove', () =>
      PROPS.graves.forEach((g, i) => {
        const [gx, gy] = project(g.x + 3, 0, g.z + 1)
        // it burns down from the top: a stub of two rows, up to the art's full height
        const { rows, pal } = CANDLE
        const tall = Math.min(rows.length, 2 + Math.round(w.candles[i].wax * (rows.length - 2)))
        for (let r = 0; r < tall; r++)
          [...rows[rows.length - 1 - r]].forEach((ch, k) => ch !== '.' && this.put(B, gx + k, gy - r, pal[ch], g.x + 3, g.z + 1, r / RES, gy, g.z + 2))
      }),
    )

    // glowcaps: where shroomfolk returned to the soil
    const glowcaps = w.memorials.map((m) => ({
      ...this.sprite(B, GLOWCAP, m.x, m.z, GLOWCAP_PAL, false, {
        glow: SPRITES.glowcap.glow,
        parts: GLOWCAP_PARTS,
        hover: { key: `glowcap${m.spot}`, name: 'a glowcap', sub: `${m.name} rests here` },
      }),
      ph: m.ph,
      key: `glowcap${m.spot}`,
    }))

    // shroomfolk (asleep ones are inside their hut)
    const caps: { glow: [number, number, number][]; by: number; dep: number; elder: boolean; key: string }[] = []
    const lanterns: { x: number; y: number; dep: number; key: string }[] = []
    let keeperEmber: { x: number; y: number; dep: number; key: string } | null = null
    for (const m of w.mush) {
      const st = m.fsm.state
      if (st === 'asleep') continue
      const key = `mush${m.id}`
      const [name, sub] = this.mushHover(m, w)
      const hover = { key, name, sub }
      if (st === 'sprouting') {
        this.sprite(B, m.size < 0.5 ? MUSH.baby : MUSH.mid, m.x, m.z, MUSH_PALS[capOf(m)], m.flip, { glow: SPRITES.shroomfolk.glow, hover, parts: MUSH_PARTS })
        continue
      }
      const keeper = w.keeperId === m.id
      const moving = WALKING.includes(st) && isMoving(m)
      const hop = mushHop(st, moving, t, m.seed, isRaining(w))
      const elder = isElder(m)
      const [, by] = project(m.x, 0, m.z)
      const sink = st === 'wilting' ? Math.round(m.sink * 10) : 0
      const cap = elder ? 'elder' : capOf(m)
      const pal = keeper ? KEEPER_PALS[cap] : MUSH_PALS[cap]
      // held up by the visitor's hand (and, once let go, dropping back down): world height to art pixels
      const air = ((m.air ?? 0) * scaleAt(m.z)) / RES
      const sp = this.sprite(B, this.mushFrame(m, w, keeper), m.x, m.z, pal, m.flip, {
        glow: (keeper ? SPRITES.keeper : SPRITES.shroomfolk).glow,
        lift: hop - sink + air,
        sinkTo: sink ? by : undefined,
        hover,
        parts: keeper ? KEEPER_PARTS : MUSH_PARTS,
        shine: keeper ? KEEPER_SHINE : undefined,
      })
      caps.push({ ...sp, elder, key })
      if (m.carrying) this.tagged(key, () => this.drawStick(B, m.x, m.z, sp.h / RES + 1 + hop))
      if (st === 'departing') lanterns.push({ x: sp.bx + (m.flip ? -4 : 4) * RES, y: sp.by - 4 * RES, dep: sp.dep + 0.02, key })
      // the keeper carries an ember from the fire, so you can always find them, even in the dark
      if (keeper) keeperEmber = { x: sp.bx + (m.flip ? -4 : 4) * RES, y: sp.by - 3 * RES, dep: sp.dep + 0.02, key }
    }

    // deer
    const D = w.deer
    const ds = D.fsm.state
    const drows = ds === 'drink' ? DEER.drink : ds === 'graze' ? DEER.walk[0] : DEER.walk[((D.step * 5) % 2) | 0]
    const deerSub = ds === 'flee' ? 'startled' : ds === 'drink' ? 'drinking' : D.thirst > 1 ? 'thirsty' : 'grazing'
    this.sprite(B, drows, D.x, D.z, DEER_PAL, D.flip, { hover: { key: 'deer', name: 'a deer', sub: deerSub }, parts: DEER_PARTS })

    // frog, mid-hop or sitting on its pad
    const F = w.frog
    const [ax, az] = PADS[F.from]
    const [bx2, bz2] = PADS[F.pad]
    const hopping = F.fsm.state === 'hop'
    const k = hopping ? F.progress : 1
    const frogX = ax + (bx2 - ax) * k
    const frogZ = az + (bz2 - az) * k
    const arc = hopping ? Math.round(Math.sin(k * Math.PI) * 4) : 0
    const frog = this.sprite(B, FROG[hopping ? 1 : 0], frogX, frogZ, FROG_PAL, bx2 < ax, {
      lift: arc + 1,
      dep: frogZ + 1,
      hover: { key: 'frog', name: 'the frog', sub: 'unimpressed' },
      parts: FROG_PARTS,
    })

    // an elk far off, at the back of the wood (the mist takes most of it): drawn at the deer's
    // pixel scale, so far off it reads as huge. Until the elk is drawn, a deer walks there instead.
    if (w.farDeer) {
      const fd = w.farDeer
      const e = elk()
      const frame = ((fd.step * 3) % 2) | 0
      if (e?.frames.walk0 && e.frames.walk1)
        this.sprite(B, frame ? e.frames.walk1 : e.frames.walk0, fd.x, fd.z, e.palettes.default, fd.dir < 0, {
          hover: { key: 'fardeer', name: 'an elk, far off', sub: 'crossing the back of the wood' },
          parts: e.parts,
          shine: e.shine,
        })
      else
        this.sprite(B, DEER.walk[((fd.step * 4) % 2) | 0], fd.x, fd.z, DEER_PAL, fd.dir < 0, {
          hover: { key: 'fardeer', name: 'a deer, far off', sub: 'crossing the back of the wood' },
          parts: DEER_PARTS,
        })
    }

    // crow on the trigon stone (in flight it's drawn with the emissives, over the sky)
    const K = w.crow
    if (K.fsm.state === 'perch') {
      const [px, py] = perchPos()
      const lookLeft = t % 6 < 3
      this.say('crow', 'a crow', 'it watches the fire too')
      this.tagged('crow', () =>
        CROW[0].forEach((row, r) =>
          [...row].forEach((ch, c) => {
            if (ch !== '.')
              this.put(B, px + (lookLeft ? 7 - c : c) - 4, py - 7 + r, CROW_PAL[ch] ?? C.crow, PROPS.trigon.x, PROPS.trigon.z, 40, py, PROPS.trigon.z + 1)
          }),
        ),
      )
    }

    // ---- emissives, depth-tested against everything above
    const R = lightRadius(w)
    const heat = w.fire.heat
    for (const cap of caps)
      this.tagged(cap.key, () => {
        // an elder's warts have dimmed with age
        for (const [gx, gy, s] of cap.glow) this.putFx(gx, gy, GLOW.cap, s * (cap.elder ? 0.53 : 1) * glow, cap.by, cap.dep + 0.01)
      })
    for (const l of lanterns)
      this.tagged(l.key, () => {
        for (let dy = 0; dy < 3; dy++)
          for (let dx = 0; dx < 2; dx++) this.putFx(l.x + dx, l.y + dy, GLOW.lantern[dy < 2 ? 0 : 1], dy < 2 ? 0.95 : 0.8, undefined, l.dep)
      })
    if (keeperEmber) {
      const e: { x: number; y: number; dep: number; key: string } = keeperEmber
      const pulse = 0.75 + 0.25 * Math.sin(t * 3)
      this.tagged(e.key, () => {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) this.putFx(e.x + dx, e.y + dy, GLOW.ember, pulse, undefined, e.dep)
        this.putFx(e.x + (Math.sin(t * 9) > 0 ? 1 : 0), e.y - 1, FLAME[2], 0.6 * pulse, undefined, e.dep, 0.6)
      })
    }
    if (F.croak > 0)
      this.tagged('frog', () => {
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) this.putFx(frog.bx + (bx2 < ax ? -4 : 2) + dx, frog.by - 5 + dy, GLOW.croak, 0.8, undefined, frog.dep + 0.01)
      })
    if (K.fsm.state === 'flying' || K.fsm.state === 'returning') {
      this.say('crow', 'a crow', 'off somewhere drier')
      this.tagged('crow', () =>
        CROW[1 + (((t * 8) % 2) | 0)].forEach((row, r) =>
          [...row].forEach((ch, c) => {
            if (ch !== '.') this.putFx(K.x + c - 5, K.y + r - 2, CROW_PAL[ch] ?? C.crow, 1, undefined, PROPS.trigon.z + 1, 0) // it flies about as far off as the trigon
          }),
        ),
      )
    }
    PROPS.huts.forEach((hut, i) =>
      this.tagged(`hut${i}`, () => {
        const [hx, hy] = project(hut.x, 0, hut.z)
        const asleep = hutOccupancy(w, i)
        const o = asleep || doorOpen(w, i) ? hutOpenings() : null
        // lamplight inside when someone's asleep; a dimmer glimpse of it through an open door
        if (o)
          for (const [dk, dr] of o.door) this.putFx(hx + dk, hy - dr, GLOW.inside, o.light * (asleep ? 1 : 0.25 / 0.45), undefined, hut.z + o.inside + 0.1, 0.3)
        if (o && asleep) for (const [dk, dr, g] of o.window) this.putFx(hx + dk, hy - dr, GLOW.window, g, undefined, hut.z + 0.05)
      }),
    )
    this.tagged('lantern', () => {
      const at = this.lanternAt
      if (!at) return
      const { lantern } = lanternCut()
      const fl = 0.75 + 0.25 * vnoise(t * 6, 7)
      const flame = Math.max(0, ...Object.values(lantern.glow))
      const h = lantern.rows.length
      lantern.rows.forEach((row, r) =>
        [...row].forEach((ch, c) => {
          const s = lantern.glow[ch]
          if (!s) return
          const up = h - 1 - r // the upper glass glows a touch differently from the lower (as on the post)
          this.putFx(at.sx + c - lantern.anchor, at.sy - up, GLOW.lantern[s === flame ? 0 : up > 4 ? 2 : 1], fl * s, at.ground, at.dep + 0.05)
        }),
      )
    })
    // burning sticks: the one in the hand, and those set down
    const tip = this.brandTip(w)
    if (tip) this.tagged('held', () => this.smallFlame(tip[0], tip[1], tip[2], t, 1))
    w.brands.forEach((b, i) => {
      const [bx, by] = project(b.x, b.y, b.z)
      const [tx, ty] = stickTip(0.35 + i)
      this.tagged(`brand${i}`, () => this.smallFlame(Math.round(bx) + tx, Math.round(by) - 2 + ty, b.z + 0.1, t + i, b.burn / 30))
    })
    const rune = this.runeOf(w)
    if (rune > 0.02)
      this.tagged('trigon', () => {
        const p = PROPS.trigon
        const [bx, by, sc] = project(p.x, 0, p.z)
        const hy = by - Math.round(Math.round(40 * sc) * 0.6)
        const pulse = rune * (0.7 + 0.3 * Math.sin(t * 2))
        // light sits in the cut, radiates faintly from the face inside it, and haloes the lip around it
        for (const [dx, dy] of TRIGON_INSIDE) this.putFx(bx + dx, hy + dy, GLOW.rune, 0.22 * pulse, undefined, p.z + 0.2, 0.4)
        for (const [dx, dy] of TRIGON_LIP) this.putFx(bx + dx, hy + dy, GLOW.rune, 0.18 * pulse, undefined, p.z + 0.2, 0.6)
        for (const [dx, dy] of trigonPx) this.putFx(bx + dx, hy + dy, GLOW.rune, pulse, undefined, p.z + 0.2)
      })
    this.tagged('grove', () =>
      PROPS.graves.forEach((g, i) => {
        const [gx, gy] = project(g.x + 3, 0, g.z + 1)
        const c = w.candles[i]
        if (c.lit) {
          const top = gy - 2 - Math.round(c.wax * 4)
          const a = (0.7 + 0.3 * vnoise(t * 7 + g.x, 2)) * (0.6 + 0.4 * c.wax)
          this.putFx(gx, top, GLOW.candle, a, gy, g.z + 2.05)
          this.putFx(gx + (vnoise(t * 5 + g.z, 3) > 0.5 ? 1 : 0), top - 1, GLOW.candle, a * 0.8, gy, g.z + 2.05)
        }
      }),
    )
    // the crown carved into the tall hearthstone warms with the fire
    this.tagged('hearth1', () => {
      const hs = HEARTHSTONES.find((h) => h.carved)
      if (!hs) return // no stone carved, nothing to warm
      const [bx, by, s] = project(hs.x, 0, hs.z)
      const cy = by - Math.round(Math.round(hs.h * s * 0.75) * 0.55)
      const warm = clamp((heat - 0.35) * 1.6)
      if (warm > 0.02)
        for (const [dx, dy] of CROWN_PX) this.putFx(bx + dx, cy + dy, GLOW.carving, warm * (0.6 + 0.2 * Math.sin(t * 1.5)), undefined, hs.z + 0.1)
    })
    // foxfire: faint violet specks on rotten wood (ambient, just pretty)
    this.tagged('foxfire', () => {
      for (const s of SHROOMS) {
        const [sx, sy] = project(s.x, 0, s.z)
        const a = 0.4 + 0.25 * Math.sin(t * 0.8 + s.ph)
        for (const [dx, dy, d] of [
          [0, 0, 0],
          [1, 0, 0],
          [3, -1, 1],
          [-2, 1, 1],
          [2, 1, 1],
        ])
          this.putFx(sx + dx, sy + dy, d ? GLOW.foxfireD : GLOW.foxfire, a * (d ? 0.7 : 1) * glow, sy, s.z + 0.05, 0.6)
      }
    })
    // glowcap caps (the mushrooms themselves are drawn with the objects)
    for (const g of glowcaps)
      this.tagged(g.key, () => {
        const pulse = 0.75 + 0.25 * Math.sin(t * 0.6 + g.ph)
        for (const [gx, gy, s] of g.glow) this.putFx(gx, gy, GLOW.memorial, pulse * s * glow, g.by, g.dep + 0.01)
      })
    EYES.forEach((e, i) => {
      const d = Math.hypot(e.x, e.z)
      if (d < R * 1.05 || (t * 0.7 + e.ph) % 4 < 0.12) return // they keep to the dark, and blink
      const [sx, sy] = project(e.x, e.y, e.z)
      const a = 0.8 * clamp((d - R * 1.05) / 15)
      this.say(`eyes${i}`, 'something in the trees', 'watching the fire')
      this.tagged(`eyes${i}`, () => {
        for (const dx of [0, 1, 4, 5]) this.putFx(sx + dx, sy, GLOW.eye, a, undefined, e.z)
        for (const dx of [2, 3]) this.putFx(sx + dx, sy, GLOW.eye, 0.01, undefined, e.z, 0) // invisible bridge, so the gap between them hovers too
      })
    })

    // The flame is a volume: two translucent sheets curved around the middle of the fire, like
    // a cylinder. The back sheet (deep reds, slower) curves away from the camera, the front
    // one (golds, faster, more see-through) bulges toward it, its base dipping into the near
    // side of the stone ring. Each pixel's depth follows the curve, so the relic stands inside
    // the fire, the logs show through it, and anyone in front of the ring still covers it.
    // The front sheet is light added on top: where the sheets overlap the fire burns hotter.
    // Size follows the fire's heat, so a fresh log swells it gradually.
    const flame = (front: boolean) => {
      const side = front ? 1 : -1
      const half0 = (front ? 3 + 5 * heat : 2.6 + 4.4 * heat) * RES
      const fh = (front ? 4 + 18 * heat : 5 + 23 * heat) * RES
      const dip = front ? 5 : 3 // how far the base curves toward (or away from) the camera, in pixels
      const seed = front ? 31 : 0
      const xr = Math.ceil(half0 + 4 * RES)
      for (let x = fireX - xr; x <= fireX + xr; x++) {
        const ub = (x - fireX) / half0
        const baseY = fireY + Math.round(side * dip * Math.sqrt(Math.max(0, 1 - ub * ub)))
        for (let y = Math.floor(baseY - fh - 2); y <= baseY; y++) {
          const dy = (baseY - y) / fh
          if (dy > 1 || dy < 0) continue
          const sway = Math.sin(t * (front ? 3.6 : 2.6) + dy * 4 + seed) * dy * 2.5 * RES
          const half = half0 * Math.pow(1 - dy, 0.7) + 0.5
          const n = front ? vnoise((x / RES) * 0.5 + seed, (y / RES) * 0.45 + t * 8.5) : vnoise((x / RES) * 0.36, (y / RES) * 0.32 + t * 6)
          const v = (1 - Math.abs(x - fireX - sway) / half) * (1 - dy * 0.6) + (n - 0.5) * 0.9 - dy * 0.35
          if (v < 0.12) continue
          const u = Math.max(-1, Math.min(1, (x - fireX - sway) / half))
          const depth = side * (0.3 + 4 * Math.sqrt(1 - u * u) * (1 - dy))
          const k = front ? (v > 0.7 ? 3 : v > 0.45 ? 2 : 1) : v > 0.75 ? 2 : v > 0.4 ? 1 : 0
          const a = front ? 0.22 + 0.45 * clamp(v) : 0.55 + 0.4 * clamp(v)
          this.putFx(x, y, FLAME[k], a, groundY, depth, front ? 0.22 : 0.18, front)
        }
      }
    }
    this.tagged('fire', () => {
      // a bed of coals in the middle of the ring, flickering pixel by pixel
      const coals = (3 + 3 * Math.min(1, heat)) * RES
      disc(
        (px, py) => this.putFx(px, py, FLAME[hash(px, py * 3 + ((t * 8) | 0)) < 0.5 ? 1 : 2], 1, groundY, (py - fireY) * 0.8, 0.3),
        fireX,
        fireY + 2,
        coals,
        3,
      )
      flame(false)
    })
    // The relic itself is drawn with the objects (drawRelic), lit like them; between the two flame
    // sheets, the back one hides behind it and the front one licks over it. Its carving glows with
    // the fire's heat on top (the bone/wood itself doesn't).
    this.tagged('relic', () => {
      const art = RELIC_ART[this.relic]
      const h = art.rows.length
      const wd = art.rows[0].length
      const warm = clamp(heat * 1.1 - 0.15)
      if (warm > 0.02)
        art.rows.forEach((row, r) =>
          [...row].forEach((ch, c) => {
            const glows = art.glow[ch] ?? 0
            if (glows) this.putFx(fireX + c - (wd >> 1), groundY + r - h, GLOW.carving, warm * (0.6 + 0.3 * vnoise(t * 3, c + r)), groundY, 0.01, glows * warm)
          }),
        )
    })
    this.tagged('fire', () => flame(true))
    // little glowing mushrooms about the wood
    for (const g of this.detailGlows) {
      this.tag = g.tag
      this.putFx(g.x, g.y, GLOW.memorial, (0.35 + 0.25 * Math.sin(t * 0.7 + g.ph)) * glow, undefined, g.dep, 0.5)
    }
    this.tag = 0
    // fireflies deep in the trees
    for (const f of w.farFlies) {
      if (f.a <= 0.02) continue
      const [px, py] = project(f.x, f.y, f.z)
      this.putFx(px, py, GLOW.firefly, f.a * 0.8 * glow, undefined, f.z, 0.8)
    }
    // moths about the fire and the lantern
    for (const m of w.moths) {
      if (m.y < 0) continue
      const [px, py] = project(m.x, m.y, m.z)
      this.putFx(px, py, C.moth, 0.85, undefined, m.z + 0.5, 0)
      if (Math.sin(t * 40 + m.seed * 9) > 0) this.putFx(px + 1, py, C.moth, 0.5, undefined, m.z + 0.5, 0)
    }
    // bats across the sky (behind the trees)
    this.tagged('bats', () => {
      for (const b of w.bats) {
        const frame = BAT[Math.sin(b.ph) > 0 ? 0 : 1]
        frame.forEach((row, r) =>
          [...row].forEach((ch, c) => ch !== '.' && this.putFx(b.x + (b.vx > 0 ? c : 4 - c) - 2, b.y + r - 1, C.bat, 1, undefined, SKY_DEPTH / 2, 0)),
        )
      }
    })
    // the owl on its branch: a dark shape, and its eyes (blinking, and now and then turned away)
    const ot = owlTree()
    if (ot) {
      const [ox, oy] = project(ot.x + ot.w * 0.9, 24, ot.z)
      this.tagged('owl', () => {
        // it stands on its bottom row, one pixel below the perch point; its eyes shut when it blinks or looks away
        const rows = OWL.frames.perch
        const pal = OWL.palettes.default
        const eyes = w.owl.away <= 0 && w.owl.blink > 0
        rows.forEach((row, r) =>
          [...row].forEach((ch, c) => {
            if (ch === '.') return
            const [dx, dy] = [c - (row.length >> 1), r - (rows.length - 2)]
            const g = OWL.glow[ch] ?? 0
            if (!g) this.putFx(ox + dx, oy + dy, pal[ch], 1, undefined, ot.z + 0.05, 0)
            else if (eyes) this.putFx(ox + dx, oy + dy, GLOW.eye, g, undefined, ot.z + 0.06, 0.6)
          }),
        )
      })
    }
    // a lightning bolt, far off behind the trees (sky depth: everything stands in front of it)
    const bolt = w.weather.bolt
    if (bolt) {
      const a = (1 - bolt.age / 0.4) * (Math.sin(bolt.age * 90) > -0.3 ? 1 : 0.35)
      const rng = rngFrom(bolt.seed)
      const strand = (x0: number, y0: number, y1: number, k: number, depth: number) => {
        let x = x0
        for (let y = y0; y < y1; y++) {
          if (y % 3 === 0) x += Math.round((rng() - 0.5) * 4)
          this.putFx(x, y, [0.92, 0.95, 1], a * k, undefined, SKY_DEPTH / 2, 1)
          this.putFx(x + 1, y, FLASH as Color, a * k * 0.4, undefined, SKY_DEPTH / 2, 1)
          // now and then a branch
          if (depth < 2 && rng() < 0.04) strand(x, y, Math.min(y1, y + 10 + rng() * 25), k * 0.6, depth + 1)
        }
      }
      strand(bolt.x, 8 * RES, HORIZON + 2, 1, 0)
    }
    // smoke when the fire is low or it's raining (steam)
    const smoky = clamp((0.5 - heat) * 1.4) + rainAmount(w) * 0.45
    if (smoky > 0.02) {
      for (let i = 0; i < 10; i++) {
        const age = (t * 0.35 + i / 10) % 1
        const sx = fireX + ((vnoise(i * 3.1, t * 0.4) - 0.5) * 8 * age + Math.sin(t + i) * age * 3) * RES
        const sy = fireY - (6 + age * 34) * RES
        const rad = 1 + Math.round(age * 2)
        disc((px, py) => this.putFx(px, py, GLOW.smoke, smoky * 0.12 * (1 - age), undefined, 0.3, 0), Math.round(sx), Math.round(sy), rad, rad)
      }
    }
    for (const e of w.embers) {
      const life = 1 - e.age / e.life
      this.putFx(fireX + e.ox * RES, groundY - e.oy * RES, [1, (120 + life * 100) / 255, 60 / 255], life, groundY, 0.2, 0.6)
    }
    for (const z of w.zs) {
      const hut = PROPS.huts[z.hut]
      const [hx, hy] = project(hut.x, 0, hut.z)
      const [cx, cy] = hutChimney()
      const zx = Math.round(hx + (cx + z.age * 3) * RES)
      const zy = Math.round(hy - (cy + z.age * 6) * RES)
      for (const [dx, dy] of ZED) this.putFx(zx + dx, zy + dy, GLOW.zzz, 0.7 * (1 - z.age / 1.8), undefined, hut.z + 0.05, 0.4)
    }
    for (const n of w.notes) {
      // up from the singer's head, swaying a little, fading as they go
      const [nx, ny] = project(n.x + Math.sin(n.age * 2.5 + n.sway) * 1.6, 13 + n.age * 4.5, n.z)
      const a = 0.85 * Math.min(1, n.age * 4) * (1 - n.age / NOTE_LIFE)
      for (const [dx, dy] of NOTES[((n.sway * 10) % 2) | 0]) this.putFx(Math.round(nx) + dx, Math.round(ny) + dy, GLOW.note, a, undefined, n.z - 0.1, 0.5)
    }
    for (const f of w.flies) {
      if (f.a <= 0.02) continue
      const [px, py] = project(f.x, f.y, f.z)
      this.putFx(px, py, GLOW.firefly, f.a * glow, project(f.x, 0, f.z)[1], f.z)
    }
    if (w.shooting) {
      const s = w.shooting
      for (let i = 0; i < 8; i++) {
        const x = s.x + (s.age * 120 - i * 2) * RES
        const y = s.y + (s.age * 40 - i * 0.66) * RES
        // only across open sky: never over the distant treeline, the ridges or the moon
        const j = Math.round(y) * W + Math.round(x)
        if (y < HORIZON && x >= 0 && x < W && this.st.sky[j] && !inMoon(x, y))
          this.putFx(x, y, GLOW.star, (1 - i / 8) * (1 - s.age / 0.9), undefined, SKY_DEPTH)
      }
    }
    // a stick you just dropped carries a soft highlight, so you can see where it went
    w.sticks.forEach((s, i) => {
      if (s.glint <= 0.02) return
      const [bx, by] = project(s.x, s.y, s.z)
      this.tagged(`stick${i}`, () => {
        for (const [dx, dy] of stickPixels(s.angle)) this.putFx(bx + dx, by - 1 + dy, GLOW.glint, 0.55 * s.glint, undefined, s.z + 0.65, 0.25)
      })
    })
    // falling sticks cast a small shadow that tightens as they near the ground; landings kick up dust
    for (const s of w.sticks) {
      if (s.landed) continue
      const [gx, gy] = project(s.x, 0, s.z)
      const spread = Math.max(1, Math.round(3 - s.y / 10)) * RES
      for (let dx = -spread; dx <= spread; dx++) this.putFx(gx + dx, gy, C.char, 0.45 * (1 - s.y / 30), undefined, s.z - 0.1, 0)
    }
    for (const p of w.puffs) {
      if (p.age < 0) continue
      const k = p.age / 0.9
      const [gx, gy] = project(p.x, 0, p.z)
      for (let i = 0; i < 4; i++) {
        const ox = (hash(p.seed, i) - 0.5) * 9 * (0.3 + k) * RES
        const oy = (-k * 4 - hash(i, p.seed) * 2) * RES
        for (let dx = 0; dx < 2; dx++) this.putFx(gx + ox + dx, gy + oy, GLOW.dust, 0.55 * (1 - k), undefined, p.z + 1, 0)
      }
    }
    for (const r of w.ripples) {
      if (r.age < 0) continue
      const a = r.age / 0.7
      const hw = ((1 + a * 4) | 0) * RES
      for (let dx = -hw; dx <= hw; dx++) this.putFx(r.x + dx, r.y, GLOW.ripple, 0.55 * (1 - a), undefined, GROUND_DEPTH, 0.2)
    }
  }

  // ---------------------------------------------------------------- lighting

  /**
   * Every light in the scene this frame, all in the same model (see lights.ts).
   * Colours include brightness; flames wobble and spill, steady glows don't.
   */
  private lights(w: World): Light[] {
    const t = w.t
    const heat = w.fire.heat
    const warm = (k: number): Color => [0.9 * k, 0.6 * k, 0.25 * k]
    const out: Light[] = []
    const fi = (0.3 + 0.7 * heat) * (0.84 + 0.16 * vnoise(t * 9, 3.3))
    out.push({
      kind: 'fire',
      name: 'campfire',
      x: 0,
      y: FIRE_Y,
      shadowY: FIRE_Y + 8,
      z: 0,
      radius: lightRadius(w),
      color: [1.7 * fi, 0.95 * fi, 0.42 * fi],
      wobble: 1,
      tail: 0.11,
      shadows: true,
      seed: 7,
    })
    {
      const fl = 0.85 + 0.15 * vnoise(t * 6, 7)
      out.push({
        kind: 'lantern',
        name: 'road lantern',
        owner: tagId('lantern'),
        // on its post as it always was; carried (or set down) it's a lantern close to the ground, so it reaches further
        ...(w.lantern.onPost && w.hand?.held?.kind !== 'lantern'
          ? { x: PROPS.lantern.x + 3.3, y: 14, z: PROPS.lantern.z, radius: 32, color: warm(1.4 * fl), tail: 0.06 }
          : {
              ...(w.hand?.held?.kind === 'lantern' ? { x: w.hand.x, y: w.hand.y - 2, z: w.hand.z } : { x: w.lantern.x, y: 3 + w.lantern.y, z: w.lantern.z }),
              radius: 40,
              color: [1.7 * fl, 1.1 * fl, 0.55 * fl] as Color,
              tail: 0.08,
            }),
        wobble: 0.5,
        shadows: true,
        seed: 3,
      })
    }
    // a burning stick in the visitor's hand (its flame, at the stick's tip), and any set down
    {
      const held = w.hand?.held
      if (w.hand && held?.kind === 'stick' && held.lit) {
        const fl = 0.8 + 0.2 * vnoise(t * 9, 11)
        const [tx] = stickTip(HELD_STICK)
        const s = ZOOM
        out.push({
          kind: 'carried',
          name: 'burning stick',
          x: w.hand.x + tx / s,
          y: w.hand.y + 4,
          z: w.hand.z,
          // it burns low before it goes out
          radius: 40 * Math.min(1, 0.45 + held.burn / 40),
          color: [1.9 * fl, 1.0 * fl, 0.42 * fl],
          wobble: 1,
          tail: 0.1,
          shadows: true,
          seed: 21,
        })
      }
      w.brands.forEach((b, i) =>
        out.push({
          kind: 'carried',
          name: `burning stick ${i}`,
          x: b.x + 2,
          y: 2 + b.y,
          z: b.z,
          radius: 30 * Math.min(1, 0.35 + b.burn / 40),
          color: warm((0.8 + 0.2 * vnoise(t * 9 + i, 12)) * 1.3),
          wobble: 1,
          tail: 0.05,
          shadows: true,
          seed: 22 + i,
        }),
      )
    }
    PROPS.graves.forEach((g, i) => {
      const c = w.candles[i]
      if (!c.lit) return
      const fl = (0.8 + 0.2 * vnoise(t * 7 + g.x, 2)) * (0.6 + 0.4 * c.wax)
      out.push({
        kind: 'candle',
        name: `candle ${i}`,
        x: g.x + 3,
        y: 3,
        z: g.z + 1,
        radius: 22,
        color: warm(1.2 * fl),
        wobble: 0.7,
        tail: 0.04,
        shadows: true,
        seed: g.x,
      })
    })
    PROPS.huts.forEach((h, i) => {
      if (hutOccupancy(w, i))
        out.push({
          kind: 'window',
          name: `hut ${i} window`,
          x: h.x + 3,
          y: 10,
          z: h.z + 3,
          radius: 18,
          color: warm(0.95),
          wobble: 0,
          tail: 0.04,
          shadows: false,
          seed: i,
        })
    })
    if (this.runeOf(w) > 0.02) {
      const k = this.runeOf(w)
      // the rune glows from inside the carving: a tight light at the cut, with a soft spill around it
      out.push({
        kind: 'rune',
        name: 'trigon rune',
        x: PROPS.trigon.x,
        y: 24,
        z: PROPS.trigon.z + 1.2,
        radius: 13,
        color: [0.2 * k, 1.0 * k, 0.95 * k],
        wobble: 0.1,
        tail: 0.09,
        shadows: false,
        seed: 11,
      })
    }
    for (const m of w.mush) {
      if (m.size < 0.5 || m.fsm.state === 'asleep') continue
      out.push({
        kind: 'cap',
        name: `${m.name}'s cap`,
        x: m.x,
        y: 6,
        z: m.z,
        radius: 8,
        color: [0.08, 0.3, 0.28],
        wobble: 0,
        tail: 0,
        shadows: false,
        seed: m.id,
        owner: tagId(`mush${m.id}`),
      })
      if (m.id === w.keeperId)
        out.push({
          kind: 'ember',
          name: `${m.name}'s ember`,
          x: m.x + (m.flip ? -3 : 3),
          y: 4,
          z: m.z,
          radius: 10,
          color: [0.75, 0.38, 0.12],
          wobble: 0.5,
          tail: 0,
          shadows: false,
          seed: m.id,
        })
      if (m.fsm.state === 'departing')
        out.push({
          kind: 'carried',
          name: `${m.name}'s lantern`,
          x: m.x + (m.flip ? -3 : 3),
          y: 5,
          z: m.z,
          radius: 15,
          color: warm(0.8),
          wobble: 0.6,
          tail: 0.03,
          shadows: false,
          seed: m.id,
        })
    }
    for (const s of SHROOMS)
      out.push({ kind: 'foxfire', name: 'foxfire', x: s.x, y: 1, z: s.z, radius: 7, color: [0.16, 0.1, 0.3], wobble: 0, tail: 0, shadows: false, seed: s.ph })
    for (const m of w.memorials)
      out.push({
        kind: 'glowcap',
        name: `${m.name}'s glowcap`,
        x: m.x,
        y: 3,
        z: m.z,
        radius: 13,
        color: [0.15, 0.6, 0.55],
        wobble: 0,
        tail: 0.03,
        shadows: false,
        seed: m.ph,
        owner: tagId(`glowcap${m.spot}`),
      })
    for (const f of w.flies)
      if (f.a > 0.05)
        out.push({
          kind: 'firefly',
          name: 'firefly',
          x: f.x,
          y: f.y,
          z: f.z,
          radius: 8,
          color: [0.5 * f.a, 0.6 * f.a, 0.2 * f.a],
          wobble: 0,
          tail: 0,
          shadows: false,
          seed: f.seed,
        })
    // in the hush, the forest's own lights reach a little further
    if (this.hush > 0)
      for (const l of out)
        if (l.kind === 'cap' || l.kind === 'foxfire' || l.kind === 'glowcap' || l.kind === 'firefly')
          l.color = [l.color[0] * (1 + 0.8 * this.hush), l.color[1] * (1 + 0.8 * this.hush), l.color[2] * (1 + 0.8 * this.hush)]
    // the editor's tuning, per kind of light
    return out.flatMap((l) => {
      const k = settings.lights[l.kind!]
      if (!k) return [l]
      if (!k.on) return []
      return [
        {
          ...l,
          y: l.y + k.height,
          shadowY: l.shadowY === undefined ? undefined : l.shadowY + k.height,
          radius: l.radius * k.radius,
          color: [l.color[0] * k.gain, l.color[1] * k.gain, l.color[2] * k.gain] as Color,
          wobble: l.wobble * k.wobble,
          tail: l.tail * k.tail,
          shadows: k.shadows === 'default' ? l.shadows : k.shadows === 'on',
        },
      ]
    })
  }

  /** This frame's lights, as prepared (and their shadow maps): both paths light with these. */
  private prepare(w: World) {
    const t = w.t
    this.moon = this.moonlight(w)
    this.moonShadow = settings.layers.shadows && this.moon.shadow > 0.01 ? this.shadows.farMap(this.moon.dir) : null
    const raw = this.lights(w)
    this.lastLights = raw
    // the strongest few shadow-casting lights get shadow maps this frame
    const strength = (l: Light) => (l.color[0] + l.color[1] + l.color[2]) * l.radius
    const casting = new Set(
      raw
        .filter((l) => l.shadows && settings.layers.shadows)
        .sort((a, b) => strength(b) - strength(a))
        .slice(0, BUDGET),
    )
    this.prepared = prepareLights(raw, t, (l) => (casting.has(l) ? this.shadows.mapFor(l) : null))
  }

  /** This frame's moonlight. */
  private moon: MoonLight = { dir: unit(0.15, 0.75, -0.65), half: unit(0.15, 1.05, 0.3), fill: 1, key: 0, hl: 0, shadow: 0 }
  /** The moon's shadow map this frame (over the whole wood), or null. */
  private moonShadow: ShadowMap | null = null

  /**
   * The moonlight, from where the moon is (its direction and height), its phase, and the clouds:
   * a full moon high overhead lights the most, a crescent near the trees the least, and cloud
   * over the moon itself dims it most of all.
   */
  private moonlight(w: World): MoonLight {
    const fam = DATA.families.moon
    const L = fam?.light ?? MOONLIGHT
    const at = this.moonAt ?? moonPlace(w.moon)
    const phase = (at.phase * Math.PI) / 180
    const { x, y } = at
    const alt = clamp((HORIZON - y) / (HORIZON - 14 * RES)) // 0 on the treeline, 1 at the top of its path
    const across = Math.max(-1, Math.min(1, (x - stoneX()) / (35 * RES))) // -1 left of the window over the stone, 1 right
    const dir = unit(Math.sin((Math.PI / 2) * across), 0.2 + 0.8 * alt, -0.35)
    const lit = 0.15 + 0.85 * ((1 + Math.cos(phase)) / 2) // how much of the face is lit
    const k = at.up ? lit * (0.35 + 0.65 * alt) : 0 // behind the stone: only the fill
    const cloud = w.weather.cloud
    const clear = 1 - Math.max(0.75 * cloud, 0.9 * cloudAt(x, y, w.t, cloud))
    return {
      dir,
      half: unit(dir[0] + VIEW[0], dir[1] + VIEW[1], dir[2] + VIEW[2]),
      fill: L.fill + 0.15 * lit,
      key: L.key * k * clear,
      hl: L.highlights * k * clear,
      // faint, and fainter still when the moon is dim or clouded over
      shadow: at.up ? (L.shadows ?? MOONLIGHT.shadows) * Math.min(1, 0.4 + k) * clear : 0,
    }
  }

  /** The CPU lighting pass (the reference; the GPU compositor ports this). */
  private compose(w: World, view: View = settings.view) {
    const t = w.t
    const B = this.fb
    const fx = this.fx
    const out = this.out
    const W8 = w.weather
    const amb = 1 - 0.2 * W8.rain - 0.08 * W8.cloud
    const flash = W8.flash
    const L = settings.layers
    const useNormals = L.normals
    const moonK = settings.ambient.moon
    const M = this.moon
    const MS = this.moonShadow
    const ms = new Float32Array(8) // a sampled moon pixel
    const lights = this.prepared
    const nrm: [number, number, number] = [0, 0, 0]
    // Light culling: most lights (caps, candles, fireflies) only reach a small patch, so each
    // 32x32 tile of the screen gathers only the lights that can reach what it shows.
    const boxes = this.tileBoxes
    boxes.fill(Infinity)
    for (let k = 0; k < TILES; k++) for (let a = 3; a < 6; a++) boxes[k * 6 + a] = -Infinity
    const grow = (k: number, x: number, y: number, z: number) => {
      const o = k * 6
      if (x < boxes[o]) boxes[o] = x
      if (y < boxes[o + 1]) boxes[o + 1] = y
      if (z < boxes[o + 2]) boxes[o + 2] = z
      if (x > boxes[o + 3]) boxes[o + 3] = x
      if (y > boxes[o + 4]) boxes[o + 4] = y
      if (z > boxes[o + 5]) boxes[o + 5] = z
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (!B.a[i]) continue
        const k = (y >> TILE_BITS) * TILES_X + (x >> TILE_BITS)
        grow(k, B.kx[i], B.ky[i], B.kz[i])
        if (B.pool[i] && !B.obj[i]) {
          // the reflection shown here (rippled up to a pixel or two sideways)
          for (const j of [i - 2, i, i + 2]) if (j >= 0 && j < N && B.ra[j]) grow(k, B.rkx[j], B.rky[j], B.rkz[j])
        }
      }
    }
    const tileLights = cullLights(lights, boxes, TILES)
    let here: Prepared[] = lights

    // Ambient moonlight (with a rim on surfaces that face the moon), plus every light source.
    const Lc: Color = [0, 0, 0]
    const light = (x: number, z: number, y: number, ground: boolean, nx: number, ny: number, nz: number, spec: number, tag: number) => {
      let moon = 1
      let normal: [number, number, number] | null = null
      if (!ground && useNormals && nz > 0) {
        nrm[0] = nx
        nrm[1] = ny
        nrm[2] = nz
        normal = nrm
        moon = 0.5 + 1.3 * Math.max(0, nrm[0] * M.dir[0] + nrm[1] * M.dir[1] + nrm[2] * M.dir[2])
      }
      // moonlight (a cool fill with a rim toward the moon), and a lightning flash lights everything for a moment
      Lc[0] = (0.15 * amb * moonK * M.fill + flash * 0.35) * moon
      Lc[1] = (0.18 * amb * moonK * M.fill + flash * 0.38) * moon
      Lc[2] = (0.27 * amb * moonK * M.fill + flash * 0.5) * moon
      // the moon's soft overhead key (banded), and highlights on whatever faces the moon
      const up = ground ? MOON_KEY[1] : normal ? Math.max(0, nrm[0] * MOON_KEY[0] + nrm[1] * MOON_KEY[1] + nrm[2] * MOON_KEY[2]) : 0.6
      const key = (Math.round(up * 4) / 4) * M.key * amb * moonK
      Lc[0] += key * 0.3
      Lc[1] += key * 0.33
      Lc[2] += key * 0.4
      if (normal) {
        const f = nrm[0] * M.dir[0] + nrm[1] * M.dir[1] + nrm[2] * M.dir[2]
        const hl = (f > 0.82 ? 1 : f > 0.62 ? 0.5 : 0) * M.hl * amb * moonK
        Lc[0] += hl * 0.42
        Lc[1] += hl * 0.48
        Lc[2] += hl * 0.58
      }
      // the moon's own faint shadows darken only its light
      if (MS) {
        const ms = (ground ? shadowAt(MS, x, z) : shadowOnObject(MS, x, z, y, tag) * OBJECT_DARKNESS) * M.shadow
        Lc[0] *= 1 - ms
        Lc[1] *= 1 - ms
        Lc[2] *= 1 - ms
      }
      gatherLight(here, x, y, z, ground, ground ? groundGrain(x, z) : 0.5, normal, Lc, tag)
      if (normal && spec > 0) {
        // metal: a tight warm glint where the surface faces the fire, a cool rim toward the moon
        const fire = lights[0]
        let lx = fire.x - x
        let ly = fire.y - y
        let lz = fire.z - z
        const d = Math.hypot(lx, ly, lz) || 1
        lx /= d
        ly /= d
        lz /= d
        const reach = Math.max(0, 1 - d / (fire.radius * 1.2))
        const hl = Math.hypot(lx, ly + VIEW[1], lz + VIEW[2]) || 1
        const fs = Math.pow(Math.max(0, (normal[0] * lx + normal[1] * (ly + VIEW[1]) + normal[2] * (lz + VIEW[2])) / hl), 9) * reach * 2.2 * spec
        const ms = Math.pow(Math.max(0, normal[0] * M.half[0] + normal[1] * M.half[1] + normal[2] * M.half[2]), 7) * 0.45 * amb * spec
        Lc[0] += fs * fire.color[0] + ms * 0.55
        Lc[1] += fs * fire.color[1] + ms * 0.65
        Lc[2] += fs * fire.color[2] + ms * 0.85
      }
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        here = tileLights[(y >> TILE_BITS) * TILES_X + (x >> TILE_BITS)]
        let r: number, g: number, b: number
        if (B.a[i]) {
          light(B.kx[i], B.kz[i], B.ky[i], B.obj[i] === 0, B.nx[i], B.ny[i], B.nz[i], B.sp[i], B.hv[i])
          r = B.r[i] * Lc[0]
          g = B.g[i] * Lc[1]
          b = B.b[i] * Lc[2]
          if (B.pool[i] && !B.obj[i] && !L.reflections) {
            r += 0.03 * amb
            g += 0.045 * amb
            b += 0.075 * amb
          } else if (B.pool[i] && !B.obj[i]) {
            // open water: dark surface + the mirrored world + mirrored emissives, gently rippled
            const ox = Math.round(Math.sin((y / RES) * 1.7 + t * 2.4) * 0.7 * RES)
            const j = y * W + Math.max(0, Math.min(W - 1, x + ox))
            if (B.ra[j]) {
              light(B.rkx[j], B.rkz[j], B.rky[j], false, B.rnx[j], B.rny[j], B.rnz[j], B.rsp[j], B.rhv[j])
              r += B.rr[j] * Lc[0] * 0.55
              g += B.rg[j] * Lc[1] * 0.55
              b += B.rb[j] * Lc[2] * 0.55
            } else {
              r += 0.03 * amb
              g += 0.045 * amb
              b += 0.075 * amb
            }
            const fa = L.emissives ? fx.ra[j] * 0.75 : 0
            if (fa > 0) {
              r = r * (1 - fa) + fx.rr[j] * fa
              g = g * (1 - fa) + fx.rg[j] * fa
              b = b * (1 - fa) + fx.rb[j] * fa
            }
          }
          let m = L.mist ? mistAt(B.kz[i]) * settings.ambient.mist : 0
          if (m > 0) {
            m = Math.min(0.95, m * (0.75 + 0.35 * vnoise((x / RES) * 0.025 + t * 0.06, (y / RES) * 0.06)))
            r = r * (1 - m) + C.mist[0] * m
            g = g * (1 - m) + C.mist[1] * m
            b = b * (1 - m) + C.mist[2] * m
          }
          // moonlit speckles on the leaves, twinkling slowly
          const gl = L.glints ? B.gl[i] : 0
          if (gl > 0) {
            const k = gl * 0.26 * amb * (1 - m) * (0.55 + 0.45 * Math.sin(t * 0.8 + x * 0.37 + y * 0.71))
            r += 0.5 * k
            g += 0.68 * k
            b += 0.75 * k
          }
        } else {
          // the sky, behind the clouds (a flash lights their undersides)
          const cd = B.sky[i] ? cloudAt(x, y, t, W8.cloud) : 0
          r = B.bgr[i] * amb
          g = B.bgg[i] * amb
          b = B.bgb[i] * amb
          if (B.sky[i] && this.sampleMoon(x, y, ms)) {
            // the moon, lit by its own sun, over the sky behind it (and under the clouds)
            const k = this.moonLit(ms)
            r += (ms[4] - B.bgr[i]) * k * amb
            g += (ms[5] - B.bgg[i]) * k * amb
            b += (ms[6] - B.bgb[i]) * k * amb
          }
          if (cd > 0) {
            const edge = cd <= 0.25
            const c = edge ? CLOUD_RIM : CLOUD
            const k = edge ? 0.55 : 0.8 + 0.15 * cd
            const f = flash * (edge ? 0.9 : 0.6)
            r = r * (1 - k) + (c[0] * amb + f * FLASH[0]) * k
            g = g * (1 - k) + (c[1] * amb + f * FLASH[1]) * k
            b = b * (1 - k) + (c[2] * amb + f * FLASH[2]) * k
          }
          r += flash * 0.18 * FLASH[0]
          g += flash * 0.18 * FLASH[1]
          b += flash * 0.18 * FLASH[2]
        }
        if (view === 'light') {
          // the light arriving here, without the surface's own colour
          const lit = B.a[i] ? 1 : 0
          r = Lc[0] * 0.5 * lit
          g = Lc[1] * 0.5 * lit
          b = Lc[2] * 0.5 * lit
        }
        const fa = L.emissives && view === 'final' ? fx.a[i] : 0
        if (fa > 0) {
          r = r * (1 - fa) + fx.r[i] * fa
          g = g * (1 - fa) + fx.g[i] * fa
          b = b * (1 - fa) + fx.b[i] * fa
        }
        out.r[i] = r
        out.g[i] = g
        out.b[i] = b
      }
    }
    if (view !== 'final') this.showBuffer(view, tileLights)
    else if (L.stars)
      for (const s of STARS) {
        const i = s.y * W + s.x
        if (B.a[i] || !B.sky[i] || inMoon(s.x, s.y)) continue // behind everything: only where the sky itself shows, never on the moon
        const a = s.b * (0.55 + 0.45 * Math.sin(t * 1.3 + s.ph)) * (1 - cloudAt(s.x, s.y, t, w.weather.cloud)) * (1 + 1.3 * this.hush) // they swell in the hush
        out.r[i] += 0.86 * a
        out.g[i] += 0.88 * a
        out.b[i] += 0.94 * a
      }
  }

  // ---------------------------------------------------------------- output

  private gpuCompositor(): GpuCompositor | null {
    if (this.gpu === undefined) this.gpu = GpuCompositor.create(W, H)
    return this.gpu
  }

  /** Everything the GPU compositor needs for this frame (the buffers themselves, no copies). */
  private gpuFrame(w: World): GpuFrame {
    if (!this.gpuChannels) {
      const B = this.fb
      const fx = this.fx
      const starB = new Float32Array(N)
      const starPh = new Float32Array(N)
      for (const s of STARS) {
        starB[s.y * W + s.x] += s.b
        starPh[s.y * W + s.x] = s.ph
      }
      this.gpuChannels = {
        ...Object.fromEntries(Object.entries(B)),
        ...Object.fromEntries(Object.entries(fx).map(([k, v]) => [`fx.${k}`, v])),
        starB,
        starPh,
      } as GpuFrame['channels']
    }
    const L = settings.layers
    return {
      channels: this.gpuChannels,
      staticVersion: this.shadows.version,
      frame: this.frameNo,
      bands: this.bandsToUpload(),
      moonDisc: MOON_DISC.up ? [MOON_DISC.x, MOON_DISC.y, MOON_DISC.r] : [0, 0, 0],
      moonFace: this.moonFace,
      moonSun: this.moonSun,
      earthshine: this.earthshine,
      fullRelief: this.fullRelief,
      starK: 1 + 1.3 * this.hush,
      lights: this.prepared,
      t: w.t,
      amb: 1 - 0.2 * w.weather.rain - 0.08 * w.weather.cloud,
      cloud: w.weather.cloud,
      flash: w.weather.flash,
      moonK: settings.ambient.moon,
      moon: this.moon,
      moonShadow: this.moonShadow,
      mistK: settings.ambient.mist,
      mistColor: C.mist,
      layers: { normals: L.normals, reflections: L.reflections, emissives: L.emissives, mist: L.mist, glints: L.glints, stars: L.stars, bloom: L.bloom },
      raining: isRaining(w),
      heat: w.fire.heat,
      bloomK: settings.ambient.bloom,
      width: W,
      height: H,
      res: RES,
      outW: W * this.scale,
      outH: H * this.scale,
    }
  }

  /**
   * The bands of rows that changed since last frame (touched now, or put back from last frame),
   * or null when everything did (the still layer changed).
   */
  private bandsToUpload(): { bits: number; mask: Uint8Array } | null {
    if (this.uploadAll) {
      this.uploadAll = false
      return null
    }
    const mask = new Uint8Array(BANDS)
    for (let b = 0; b < BANDS; b++) mask[b] = this.touched[b] | this.touchedBefore[b]
    return { bits: BAND_BITS, mask }
  }

  /** The CPU vs GPU view: the CPU frame dimmed, with every pixel where the GPU disagrees in red (x8). */
  private showDiff(lit: Float32Array) {
    const out = this.out
    let sum = 0
    let max = 0
    let over = 0
    for (let i = 0; i < N; i++) {
      const c = [clamp(out.r[i]), clamp(out.g[i]), clamp(out.b[i])]
      const d = Math.max(Math.abs(c[0] - clamp(lit[i * 4])), Math.abs(c[1] - clamp(lit[i * 4 + 1])), Math.abs(c[2] - clamp(lit[i * 4 + 2])))
      sum += d
      if (d > max) max = d
      if (d > 1.5 / 255) over++
      const g = (c[0] + c[1] + c[2]) / 3
      out.r[i] = g * 0.3 + d * 8
      out.g[i] = g * 0.3
      out.b[i] = g * 0.3
    }
    this.gpuDiff = { mean: sum / N, max, over: over / N }
  }

  /** Replace the frame with one of the buffers behind it (the editor's views). */
  private showBuffer(view: View, tileLights: Prepared[][]) {
    const B = this.fb
    const fx = this.fx
    const out = this.out
    const ms = new Float32Array(8)
    for (let i = 0; i < N; i++) {
      let r = 0
      let g = 0
      let b = 0
      const obj = B.a[i] && B.obj[i]
      // the moon, where it shows (open sky)
      const moon = !B.a[i] && B.sky[i] && (view === 'albedo' || view === 'normals') && this.sampleMoon(i % W, (i / W) | 0, ms)
      switch (view) {
        case 'albedo':
          ;[r, g, b] = B.a[i] ? [B.r[i], B.g[i], B.b[i]] : [B.bgr[i], B.bgg[i], B.bgb[i]]
          if (moon) [r, g, b] = [r + (ms[4] - r) * ms[3], g + (ms[5] - g) * ms[3], b + (ms[6] - b) * ms[3]]
          break
        case 'normals':
          if (obj && B.nz[i] > 0) [r, g, b] = [B.nx[i] * 0.5 + 0.5, B.ny[i] * 0.5 + 0.5, B.nz[i]]
          else if (B.a[i])
            [r, g, b] = [0.5, 0.75, 0.6] // the ground faces up
          else if (moon) [r, g, b] = [(ms[0] * 0.5 + 0.5) * ms[3], (ms[1] * 0.5 + 0.5) * ms[3], ms[2] * ms[3]]
          break
        case 'depth': {
          if (obj) r = g = b = clamp((B.dep[i] + 100) / 180)
          else if (B.a[i]) [r, g, b] = [0.05, 0.08, 0.2]
          break
        }
        case 'shadows': {
          // how shadowed the ground is, from every light that casts shadows (darker = more)
          if (B.a[i] && !B.obj[i]) {
            let occ = 0
            for (const l of this.prepared) if (l.shadow) occ = Math.max(occ, shadowAt(l.shadow, B.kx[i], B.kz[i]))
            r = g = b = 0.85 - occ * 0.75
          } else if (B.a[i]) [r, g, b] = [0.25, 0.18, 0.12]
          break
        }
        case 'emissive':
          ;[r, g, b] = [fx.r[i] * fx.a[i], fx.g[i] * fx.a[i], fx.b[i] * fx.a[i]]
          break
        case 'hover': {
          const h = B.hv[i]
          if (h) [r, g, b] = [hash(h, 1) * 0.8 + 0.2, hash(h, 2) * 0.8 + 0.2, hash(h, 3) * 0.8 + 0.2]
          break
        }
        case 'tiles': {
          const x = i % W
          const y = (i / W) | 0
          const n = tileLights[(y >> TILE_BITS) * TILES_X + (x >> TILE_BITS)].length
          const k = clamp(n / 12)
          const edge = (x & 31) === 0 || (y & 31) === 0 ? 0.25 : 0
          r = out.r[i] * 0.35 + k + edge
          g = out.g[i] * 0.35 + (1 - k) * 0.25 * (n > 0 ? 1 : 0) + edge
          b = out.b[i] * 0.35 + edge
          break
        }
        default:
          continue // 'light' is written while composing
      }
      out.r[i] = r
      out.g[i] = g
      out.b[i] = b
    }
  }

  /** The hover tag key of the thing at this pixel ('hut0', 'tree12', ...), or null. */
  tagAt(x: number, y: number): string | null {
    if (x < 0 || x >= W || y < 0 || y >= H) return null
    const id = this.fb.hv[y * W + x]
    if (!id) return null
    for (const [k, v] of TAGS) if (v === id) return k
    return null
  }

  /** Everything about one pixel of the last frame, and how much each light gives it. */
  inspectPixel(x: number, y: number): PixelInfo | null {
    if (x < 0 || x >= W || y < 0 || y >= H) return null
    const B = this.fb
    const fx = this.fx
    const i = y * W + x
    const what = !B.a[i] ? 'sky' : B.obj[i] ? 'object' : 'ground'
    const tag = B.hv[i]
    const ground = what === 'ground'
    const normal: [number, number, number] | null = what === 'object' && B.nz[i] > 0 ? [B.nx[i], B.ny[i], B.nz[i]] : null
    const lights =
      what === 'sky'
        ? []
        : this.prepared
            .map((l) => {
              const c: Color = [0, 0, 0]
              gatherLight([l], B.kx[i], B.ky[i], B.kz[i], ground, ground ? groundGrain(B.kx[i], B.kz[i]) : 0.5, settings.layers.normals ? normal : null, c, tag)
              return { name: l.name ?? '?', kind: l.kind ?? '?', amount: 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2], color: c }
            })
            .filter((l) => l.amount > 0.002)
            .sort((a, b) => b.amount - a.amount)
    return {
      x,
      y,
      what,
      owner: this.labels.get(tag)?.[0] ?? null,
      depth: B.dep[i],
      world: [B.kx[i], B.ky[i], B.kz[i]],
      normal,
      albedo: B.a[i] ? [B.r[i], B.g[i], B.b[i]] : [B.bgr[i], B.bgg[i], B.bgb[i]],
      material: { micro: B.mh[i], weight: B.mw[i], spec: B.sp[i], glint: B.gl[i] },
      emissive: fx.a[i] > 0 ? { a: fx.a[i], color: [fx.r[i], fx.g[i], fx.b[i]], depth: fx.dep[i], bloom: fx.bw[i] } : null,
      pool: !!B.pool[i],
      out: [this.out.r[i], this.out.g[i], this.out.b[i]],
      lights,
    }
  }

  /** The editor's overlays, drawn over the finished frame at output resolution. */
  private drawOverlays(w: World) {
    const O = settings.overlays
    const sel = settings.selectedLight
    const insp = settings.inspect
    const pick = settings.selection
    if (!O.lights && !O.casters && !O.nav && !O.paths && !sel && !insp && !pick) return
    const { ctx, scale: S } = this
    ctx.save()
    ctx.lineWidth = Math.max(1, S / 2)
    const ellipse = (x: number, z: number, r: number, stroke: string, fill?: string) => {
      const [cx, cy, s] = project(x, 0, z)
      ctx.beginPath()
      ctx.ellipse(cx * S, cy * S, Math.max(1, r * s * S), Math.max(1, r * 1.215 * S), 0, 0, Math.PI * 2)
      if (fill) {
        ctx.fillStyle = fill
        ctx.fill()
      }
      ctx.strokeStyle = stroke
      ctx.stroke()
    }
    if (O.nav) {
      ctx.fillStyle = 'rgba(255,70,70,0.28)'
      for (let z = -100; z < 90; z += 2)
        for (let x = -170; x < 170; x += 2) {
          if (walkable(x, z)) continue
          const [sx, sy] = project(x, 0, z)
          if (sx < 0 || sx >= W || sy < HORIZON || sy >= H) continue
          ctx.fillRect(sx * S - S, sy * S - S, 2 * S, 2 * S)
        }
    }
    if (O.paths) {
      ctx.strokeStyle = 'rgba(159,245,228,0.8)'
      for (const m of w.mush) {
        const pts = [[m.x, m.z], ...(m.path ?? []), ...(m.route ?? [])]
        if (pts.length < 2) continue
        ctx.beginPath()
        pts.forEach(([x, z], k) => {
          const [sx, sy] = project(x, 0, z)
          if (k) ctx.lineTo(sx * S, sy * S)
          else ctx.moveTo(sx * S, sy * S)
        })
        ctx.stroke()
      }
    }
    if (O.casters) {
      // every caster's silhouette, as recorded when it was drawn, and its foot
      for (const sil of [...this.shadows.statics, ...this.shadows.dynamics]) {
        const [bx, by] = project(sil.x, 0, sil.z)
        ctx.fillStyle = 'rgba(255,200,80,0.35)'
        for (let k = 0; k < sil.runs.length; k += 3)
          ctx.fillRect((bx + sil.runs[k]) * S, (by - sil.runs[k + 2]) * S, S, (sil.runs[k + 2] - sil.runs[k + 1]) * S)
        ellipse(sil.x, sil.z, 0.6, 'rgba(255,120,60,0.9)')
      }
    }
    if (O.lights || sel) {
      for (const l of this.lastLights) {
        const on = l.kind === sel
        if (!O.lights && !on) continue
        const [lx, ly] = project(l.x, l.y, l.z)
        const [gx, gy] = project(l.x, 0, l.z)
        const col = on ? 'rgba(255,220,120,0.95)' : 'rgba(255,220,120,0.35)'
        ellipse(l.x, l.z, l.radius, col)
        ctx.strokeStyle = col
        ctx.beginPath()
        ctx.moveTo(gx * S, gy * S)
        ctx.lineTo(lx * S, ly * S)
        ctx.stroke()
        ctx.fillStyle = `rgb(${Math.min(255, l.color[0] * 200)},${Math.min(255, l.color[1] * 200)},${Math.min(255, l.color[2] * 200)})`
        ctx.fillRect(lx * S - 2 * S, ly * S - 2 * S, 4 * S, 4 * S)
      }
    }
    if (pick) {
      // what the move tool has selected
      ctx.setLineDash([3 * S, 2 * S])
      ellipse(pick.x, pick.z, 4, 'rgba(240,138,60,0.95)')
      ctx.setLineDash([])
    }
    if (insp) {
      const x = (insp.x + 0.5) * S
      const y = (insp.y + 0.5) * S
      ctx.strokeStyle = '#fff'
      ctx.strokeRect(insp.x * S - 0.5, insp.y * S - 0.5, S + 1, S + 1)
      ctx.beginPath()
      ctx.moveTo(x - 8 * S, y)
      ctx.lineTo(x - 2 * S, y)
      ctx.moveTo(x + 2 * S, y)
      ctx.lineTo(x + 8 * S, y)
      ctx.moveTo(x, y - 8 * S)
      ctx.lineTo(x, y - 2 * S)
      ctx.moveTo(x, y + 2 * S)
      ctx.lineTo(x, y + 8 * S)
      ctx.stroke()
    }
    ctx.restore()
  }

  private present(w: World, gpuCanvas: HTMLCanvasElement | null = null) {
    const { ctx, scale: S, fx, out } = this
    const DW = W * S
    const DH = H * S
    if (gpuCanvas) {
      // the GPU drew the lit frame and its bloom at the output size
      ctx.drawImage(gpuCanvas, 0, 0)
      if (settings.layers.bloom && settings.layers.emissives) this.drawWarmWash(w)
      this.drawOver(w)
      return
    }
    const d = this.outImg.data
    const e = this.fxImg.data
    for (let i = 0; i < N; i++) {
      const o = i * 4
      d[o] = clamp(out.r[i]) * 255
      d[o + 1] = clamp(out.g[i]) * 255
      d[o + 2] = clamp(out.b[i]) * 255
      d[o + 3] = 255
      const ra = fx.ra[i] * 0.6 * fx.rbw[i]
      const useR = ra > fx.a[i]
      e[o] = (useR ? fx.rr[i] : fx.r[i]) * 255
      e[o + 1] = (useR ? fx.rg[i] : fx.g[i]) * 255
      e[o + 2] = (useR ? fx.rb[i] : fx.b[i]) * 255
      e[o + 3] = Math.max(fx.a[i] * fx.bw[i], ra) * 255
    }
    this.outX.putImageData(this.outImg, 0, 0)
    this.fxX.putImageData(this.fxImg, 0, 0)

    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(this.outC, 0, 0, DW, DH)
    if (settings.layers.bloom && settings.layers.emissives && settings.view === 'final') {
      // soft bloom from the emissive layer, plus a faint warm wash around the fire
      const heat = Math.min(1.2, w.fire.heat)
      ctx.globalCompositeOperation = 'lighter'
      ctx.imageSmoothingEnabled = true
      ctx.filter = `blur(${3 * S * RES}px)`
      ctx.globalAlpha = Math.min(1, 0.85 * (0.45 + 0.55 * heat) * settings.ambient.bloom)
      ctx.drawImage(this.fxC, 0, 0, DW, DH)
      ctx.filter = `blur(${9 * S * RES}px)`
      ctx.globalAlpha = Math.min(1, 0.55 * (0.3 + 0.7 * heat) * settings.ambient.bloom)
      ctx.drawImage(this.fxC, 0, 0, DW, DH)
      ctx.filter = 'none'
      ctx.globalAlpha = 1
    }
    ctx.restore()
    if (settings.layers.bloom && settings.layers.emissives && settings.view === 'final') this.drawWarmWash(w)
    this.drawOver(w)
  }

  /** A faint warm wash around the fire (with the bloom). */
  private drawWarmWash(w: World) {
    const { ctx, scale: S } = this
    const DW = W * S
    const DH = H * S
    const heat = Math.min(1.2, w.fire.heat)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const [fsx, fsy] = project(0, 8, 0)
    const fl = heat * (0.85 + 0.15 * vnoise(w.t * 9, 1))
    ctx.translate(fsx * S, fsy * S)
    ctx.scale(1, 0.6)
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, lightRadius(w) * 1.5 * S * RES)
    gr.addColorStop(0, `rgba(255,140,60,${0.07 * fl})`)
    gr.addColorStop(0.4, `rgba(255,110,40,${0.025 * fl})`)
    gr.addColorStop(1, 'rgba(255,100,30,0)')
    ctx.fillStyle = gr
    ctx.fillRect(-DW, -DH * 2, DW * 2, DH * 4)
    ctx.restore()
  }

  /** What draws over the finished frame: rain, labels, debug text, the editor's overlays. */
  private drawOver(w: World) {
    if (rainAmount(w) > 0 && settings.layers.rain) this.drawRain(w)
    if (settings.layers.labels) this.drawHover()
    else this.hovered = null
    if (settings.overlays.states) this.drawDebug(w)
    this.drawOverlays(w)
  }

  /** Rain as straight, thin streaks at full output resolution, over the pixel art. */
  private drawRain(w: World) {
    const { ctx, scale: S } = this
    const thin = Math.max(1, Math.round(S / 4))
    ctx.save()
    const rain = rainAmount(w)
    ctx.fillStyle = `rgba(165,185,215,${0.16 + 0.18 * rain})`
    const n = Math.round(w.drops.length * rain)
    for (let k = 0; k < n; k++) {
      const r = w.drops[k]
      const len = (r.v / 240) * 7 * S // faster drops streak longer
      ctx.fillRect(Math.round(r.x * S), Math.round(r.y * S - len), thin, len)
    }
    ctx.restore()
  }

  /**
   * Name whatever is under the pointer. Every drawn pixel knows what it belongs to, so this is
   * exact: the glowcap behind the grave answers for its own pixels. A pixel or two of slack
   * makes small things easy to catch.
   */
  /** What's under the pointer (in the last frame drawn): sets `hovered` and `hoverKey`, and returns its tag. */
  pick(): number {
    const p = this.pointer
    this.hovered = null
    this.hoverKey = null
    if (!p) return 0
    const B = this.fb
    const px = Math.floor(p.x)
    const py = Math.floor(p.y)
    let id = 0
    for (let ring = 0; ring <= 2 && !id; ring++) {
      for (let dy = -ring; dy <= ring && !id; dy++) {
        for (let dx = -ring; dx <= ring && !id; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const x = px + dx
          const y = py + dy
          if (x < 0 || x >= W || y < 0 || y >= H) continue
          const t = B.hv[y * W + x]
          if (t && this.labels.has(t) && this.notHeld(t)) id = t
        }
      }
    }
    const inside = px >= 0 && px < W && py >= 0 && py < H
    if (!id && inside && B.pool[py * W + px] && !B.obj[py * W + px]) id = tagId('pool')
    const label = this.labels.get(id)
    if (!label) return 0
    this.hovered = [label[0], label[1]]
    this.hoverKey = TAG_KEYS.get(id) ?? null
    return id
  }

  /** The hover key of what the visitor's hand is holding (it doesn't name itself while it's in the hand). */
  heldKey: string | null = null
  private notHeld(id: number) {
    return !this.heldKey || TAG_KEYS.get(id) !== this.heldKey
  }

  private drawHover() {
    const id = this.pick()
    const label = this.labels.get(id)
    if (!id || !label) return
    const B = this.fb
    const px = Math.floor(this.pointer!.x)
    // place the name under the part of the thing near the pointer (wide things like the grove
    // spread across the screen), wrapped, and kept inside the frame
    let x0 = W
    let x1 = 0
    let y0 = H
    let y1 = 0
    const pool = id === tagId('pool')
    const near = 28 * RES
    for (let y = 0; y < H; y++) {
      for (let x = Math.max(0, px - near); x < Math.min(W, px + near); x++) {
        const i = y * W + x
        if (pool ? !(B.pool[i] && !B.obj[i]) : B.hv[i] !== id) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    if (x1 < x0) return
    const { ctx, scale: S } = this
    // output pixels per base pixel: text keeps its size at any resolution, but never so small on
    // screen that it can't be read (a phone, or a small frame): its name at least LABEL_MIN CSS px
    const perCss = this.cssWidth ? (W * S) / this.cssWidth : 1
    const U = Math.max(S * RES, (LABEL_MIN / 3.25) * perCss)
    ctx.save()
    ctx.textAlign = 'center'
    const nameFont = `${3.25 * U}px ${FONT}`
    const subFont = `${2.75 * U}px ${FONT}`
    ctx.font = subFont
    const lines = wrapText(ctx, label[1], 84 * U)
    ctx.font = nameFont
    const widest = Math.max(ctx.measureText(label[0]).width, ...lines.map((l) => ((ctx.font = subFont), ctx.measureText(l).width)))
    const half = widest / 2 + 3 * U
    const x = Math.max(half, Math.min(W * S - half, ((x0 + x1) / 2) * S))
    const height = (4 + lines.length * 4) * U
    const below = !label[2] && y1 * S + 6.5 * U + height < H * S - 2 * U
    const y = below ? y1 * S + 6.5 * U : y0 * S - 3 * U - height + 3.25 * U
    ctx.font = nameFont
    ctx.fillStyle = 'rgba(233,227,212,0.95)'
    ctx.fillText(label[0], x, y)
    ctx.font = subFont
    ctx.fillStyle = 'rgba(154,151,140,0.95)'
    lines.forEach((l, k) => ctx.fillText(l, x, y + (4 + k * 3.6) * U))
    ctx.restore()
  }

  private drawDebug(w: World) {
    const { ctx, scale: S } = this
    ctx.save()
    const U = S * RES
    ctx.font = `${3 * U}px ${FONT}`
    ctx.textAlign = 'center'
    const tag = (txt: string, x: number, y: number, col: string) => {
      const m = ctx.measureText(txt).width
      const left = ctx.textAlign === 'left' ? x : x - m / 2
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(left - U, y - 2.75 * U, m + 2 * U, 3.75 * U)
      ctx.fillStyle = col
      ctx.fillText(txt, x, y)
    }
    for (const m of w.mush) {
      if (m.fsm.state === 'asleep') continue
      const [sx, sy] = project(m.x, 0, m.z)
      tag(`${m.name} · ${m.fsm.state} · e ${m.energy.toFixed(2)} · age ${Math.round((m.age / m.lifespan) * 100)}%`, sx * S, sy * S - 11 * U, '#9ff5e4')
    }
    const D = w.deer
    const [dx, dy] = project(D.x, 0, D.z)
    tag(`${D.fsm.state} · thirst ${D.thirst.toFixed(2)}`, dx * S, dy * S - 14 * U, '#e8c29a')
    ctx.textAlign = 'left'
    const wx = w.weather
    const asleep = PROPS.huts.map((_, i) => hutOccupancy(w, i)).reduce((a, b) => a + b, 0)
    const lines = [
      `weather ${wx.fsm.state} ${wx.manual ? '(manual)' : Math.ceil(wx.timer) + 's'}   pool ${w.poolLevel.toFixed(2)}`,
      `fire ${w.fire.fsm.state} · fuel ${w.fire.fuel.toFixed(2)} · heat ${w.fire.heat.toFixed(2)}   pile ${w.pile}   sticks ${w.sticks.length}`,
      `knight ${w.knight.fsm.state} · vigil ${Math.round((w.knight.vigil / w.knight.vigilLength) * 100)}%   frog ${w.frog.fsm.state}   crow ${w.crow.fsm.state}   village ${w.mush.length}   asleep ${asleep}   glowcaps ${w.memorials.length}`,
    ]
    lines.forEach((l, i) => tag(l, 4 * U, (6 + i * 4.5) * U, '#f08a3c'))
    ctx.restore()
  }
}
