/**
 * Shadows, for any light.
 *
 * Casters: everything drawn between beginCaster/endCaster in the renderer is one caster, and
 * every pixel it draws (before the depth test, so hidden parts still cast) is recorded into
 * its silhouette, on a 2px grid. So the knight casts the knight, a hut casts a hut.
 *
 * Maps: a light that casts shadows gets a shadow map, a square of ground around it sized to
 * its reach. For each silhouette the light can see, the silhouette is turned to face the
 * light (right for trunks and stems, good enough for flat creatures), each sample's ray from
 * the light is followed to the ground, and a soft dab is laid there. Dabs widen with distance
 * from the caster (the penumbra). Parts of a caster near or above the light's height would
 * throw their shadow to the horizon from a point; the fire is a big soft light, so those
 * stretch and fade out instead.
 *
 * Things standing in a shadow: besides darkening the ground, each map keeps, per cell, the band
 * of heights the shadow passes through there (between the rays over a caster's top and under
 * its foot), so a creature behind the knight darkens from its feet up to where his shadow
 * reaches. Every caster's shadow knows who cast it, and nothing is shadowed by itself.
 *
 * Cost: static silhouettes are baked into a light's map once, and again only when the light
 * moves or its reach changes step. Moving things are laid on top, again only when one near the
 * light has moved or changed its pose: a still light in a still corner costs nothing a frame
 * (and its map isn't sent to the GPU again: `version` says when it changed). Up to BUDGET of
 * the strongest shadow lights in a frame get maps.
 */
import type { Light } from './lights'

/** One caster: its base on the ground, its scale (screen px per world unit), its silhouette. */
export interface Silhouette {
  x: number
  z: number
  s: number
  /** Column width in screen pixels (each run covers one column). */
  col: number
  /** The caster's hover tag (it isn't shadowed by itself) and half-width in world units. */
  tag: number
  r: number
  /** Where the base really is, in screen pixels right of the (rounded) pixel the runs are measured from. */
  ox: number
  /**
   * The silhouette as vertical runs, [dx, y0, y1] triples in screen pixels from the base:
   * a column dx px right of the base, filled from y0 up to y1 px above it.
   */
  runs: Int16Array
}

export interface ShadowMap {
  x0: number
  z0: number
  cell: number
  n: number
  /** How shadowed the ground is. */
  occ: Float32Array
  /** For things standing in it: how strong, the band of heights it covers, and who cast it. */
  oa: Float32Array
  lo: Float32Array
  hi: Float32Array
  owner: Int32Array
  /** Bumped whenever its contents change. */
  version: number
  /** The cells that changed with the last version, [i0, j0, i1, j1] (inclusive); null: maybe any. */
  dirty: number[] | null
  /** The cells drawn into since it was last reset (a running box, as `dirty`). */
  drawn: number[]
}

const newMap = (x0: number, z0: number, cell: number, n: number): ShadowMap => ({
  x0,
  z0,
  cell,
  n,
  occ: new Float32Array(n * n),
  oa: new Float32Array(n * n),
  lo: new Float32Array(n * n),
  hi: new Float32Array(n * n),
  owner: new Int32Array(n * n),
  version: 0,
  dirty: null,
  drawn: noBox(),
})
const noBox = () => [Infinity, Infinity, -Infinity, -Infinity]
const grow = (b: number[], i0: number, j0: number, i1: number, j1: number) => {
  b[0] = Math.min(b[0], i0)
  b[1] = Math.min(b[1], j0)
  b[2] = Math.max(b[2], i1)
  b[3] = Math.max(b[3], j1)
}
const copyMap = (to: ShadowMap, from: ShadowMap) => {
  to.occ.set(from.occ)
  to.oa.set(from.oa)
  to.lo.set(from.lo)
  to.hi.set(from.hi)
  to.owner.set(from.owner)
  to.version++
  to.dirty = null
}

/** How much less dark a shadow is on things standing in it than on the ground. */
export const OBJECT_DARKNESS = 0.6

/** At most this many lights cast shadows in one frame (the strongest). */
export const BUDGET = 50
/** How dark a full shadow is (1 = no light at all). */
export const DARKNESS = 0.85

/** Collects one caster's pixels while it's drawn. */
export class SilhouetteRecorder {
  private cells = new Set<number>()
  /** Columns are `col` pixels wide (finer for static things, coarser for moving ones). */
  // runs are measured from the rounded base pixel, so a creature drifting by a fraction of a
  // pixel doesn't reshuffle its columns; the fraction is kept to place them exactly
  private bx: number
  private by: number
  private ox: number
  constructor(
    readonly x: number,
    readonly z: number,
    bx: number,
    by: number,
    readonly s: number,
    readonly col = 2,
    readonly tag = 0,
  ) {
    this.bx = Math.round(bx)
    this.by = Math.round(by)
    this.ox = this.bx - bx
  }
  add(px: number, py: number) {
    const cx = Math.floor((px - this.bx) / this.col)
    const cy = (this.by - py) >> 1
    if (cx < -1000 || cx > 1000 || cy < -1000 || cy > 1000) return
    this.cells.add((cx + 1024) * 4096 + (cy + 1024))
  }
  done(): Silhouette | null {
    if (!this.cells.size) return null
    // sort by column, then height, and merge each column's cells into runs
    const cells = [...this.cells].sort((a, b) => a - b)
    const runs: number[] = []
    let cx = NaN
    let y0 = 0
    let y1 = 0
    const flush = () => Number.isFinite(cx) && runs.push(cx * this.col + this.col / 2, y0 * 2, y1 * 2 + 2)
    for (const c of cells) {
      const x = Math.floor(c / 4096) - 1024
      const y = (c % 4096) - 1024
      if (x === cx && y === y1 + 1) y1 = y
      else {
        flush()
        cx = x
        y0 = y1 = y
      }
    }
    flush()
    let r = 0
    for (let k = 0; k < runs.length; k += 3) r = Math.max(r, Math.abs(runs[k] + this.ox) + this.col / 2)
    return { x: this.x, z: this.z, s: this.s, col: this.col, ox: this.ox, tag: this.tag, r: r / this.s, runs: Int16Array.from(runs) }
  }
}

/** Lay one silhouette's shadow from light `l` into a map. */
function splat(map: ShadowMap, l: Light, sil: Silhouette) {
  const dx = sil.x - l.x
  const dz = sil.z - l.z
  const d = Math.hypot(dx, dz)
  if (d < 0.5) return // the light is inside it
  // the silhouette turned to face the light: its width runs across the light's direction,
  // turned the short way (by at most 90°) from facing the camera, so the sprite's right
  // stays on the +x side: a deer facing right casts a shadow facing right, whether it
  // stands in front of the light or behind it
  const side = dz >= 0 ? 1 : -1
  const px = (side * dz) / d
  const pz = (-side * dx) / d
  const ly = Math.max(0.5, l.shadowY ?? l.y)
  const half = (map.n * map.cell) / 2
  const runs = sil.runs
  const colR = sil.col / 2 / sil.s // half a column's width, in world units: neighbouring strokes meet
  for (let k = 0; k < runs.length; k += 3) {
    const u = (runs[k] + sil.ox) / sil.s
    const yBot = runs[k + 1] / sil.s
    const yTop = Math.min(runs[k + 2] / sil.s, ly * (1 - 1 / MAX_STRETCH)) // nothing past the stretch limit
    if (yBot >= yTop) continue
    // the run stands at (wx, wz); its shadow runs along the ground from where its foot's ray
    // lands (t0) to where its top's does (t1), t being the stretch past the run itself
    const wx = sil.x + px * u
    const wz = sil.z + pz * u
    const t0 = ly / (ly - yBot)
    const t1 = ly / (ly - yTop)
    let t = t0
    while (t <= t1) {
      const gx = l.x + (wx - l.x) * t
      const gz = l.z + (wz - l.z) * t
      if (Math.abs(gx - l.x) > half || Math.abs(gz - l.z) > half) break
      const spread = Math.hypot(gx - wx, gz - wz)
      // wider and fainter the further it stretches: a big soft light, not a point
      const core = colR * t + spread * 0.04
      const soft = map.cell * 0.75 + spread * 0.06
      const fade = Math.min(1, Math.max(0, 1 - (t - 1) / (MAX_STRETCH - 1)))
      dab(map, gx, gz, core, soft, fade)
      // the next dab, about half a dab further along the ground
      const step = Math.max(map.cell * 0.5, (core + soft) * 0.4)
      const dist = Math.hypot(wx - l.x, wz - l.z)
      t += step / Math.max(0.01, dist)
    }
    // things standing behind it: from just behind the caster out to where its top's ray lands,
    // the shadow covers the heights between the rays over its top and under its foot
    const dist = Math.max(0.01, Math.hypot(wx - l.x, wz - l.z))
    t = 1 + (sil.r + colR) / dist
    while (t <= t1) {
      const hi = ly + (yTop - ly) * t
      if (hi <= 0.3) break
      const lo = Math.max(0, ly + (yBot - ly) * t)
      const gx = l.x + (wx - l.x) * t
      const gz = l.z + (wz - l.z) * t
      if (Math.abs(gx - l.x) > half || Math.abs(gz - l.z) > half) break
      const core = colR * t
      const soft = map.cell * 0.75
      const fade = Math.min(1, Math.max(0, 1 - (t - 1) / (MAX_STRETCH - 1)))
      band(map, gx, gz, core, soft, fade, lo, hi, sil.tag)
      t += Math.max(map.cell * 0.5, (core + soft) * 0.4) / dist
    }
  }
}

/**
 * Lay one silhouette's shadow from a far light coming from direction `dir` (toward it, like the
 * moon): every ray is parallel, so the shadow doesn't widen with distance, only softens; it
 * runs away from the light across the ground, as long as the caster is tall over how high the
 * light stands (capped, fading toward the cap).
 */
function splatFar(map: ShadowMap, dir: readonly number[], sil: Silhouette) {
  const hl = Math.hypot(dir[0], dir[2])
  if (hl < 1e-3 || dir[1] <= 0.02) return
  // across the ground, away from the light; and how far a shadow runs per unit of height
  const ax = -dir[0] / hl
  const az = -dir[2] / hl
  const run = hl / dir[1]
  // the silhouette turned to face the light (the short way, as for a point light)
  const side = az >= 0 ? 1 : -1
  const px = side * az
  const pz = -side * ax
  const runs = sil.runs
  const colR = sil.col / 2 / sil.s
  for (let k = 0; k < runs.length; k += 3) {
    const u = (runs[k] + sil.ox) / sil.s
    const yBot = runs[k + 1] / sil.s
    const yTop = runs[k + 2] / sil.s
    if (yBot >= yTop) continue
    const wx = sil.x + px * u
    const wz = sil.z + pz * u
    // along the ground from under its foot's ray to under its top's
    const s0 = yBot * run
    const s1 = Math.min(yTop * run, FAR_MAX)
    for (let d = s0; d <= s1;) {
      const fade = Math.min(1, Math.max(0, 1 - (d - FAR_MAX * 0.6) / (FAR_MAX * 0.4)))
      const core = colR + d * 0.02
      const soft = map.cell * 0.75 + d * 0.05
      dab(map, wx + ax * d, wz + az * d, core, soft, fade)
      d += Math.max(map.cell * 0.5, (core + soft) * 0.4)
    }
    // things standing in it: just behind the caster out to where its top's shadow lands, the
    // heights between the rays over its top and under its foot
    for (let d = sil.r + colR; d <= s1;) {
      const hi = yTop - d / run
      if (hi <= 0.3) break
      const lo = Math.max(0, yBot - d / run)
      const fade = Math.min(1, Math.max(0, 1 - (d - FAR_MAX * 0.6) / (FAR_MAX * 0.4)))
      band(map, wx + ax * d, wz + az * d, colR, map.cell * 0.75, fade, lo, hi, sil.tag)
      d += Math.max(map.cell * 0.5, (colR + map.cell * 0.75) * 0.4)
    }
  }
}
/** A far light's shadows run at most this far along the ground (world units). */
const FAR_MAX = 70

/** Like dab(), for the heights a shadow covers: keeps the union of the bands, and the strongest caster. */
function band(map: ShadowMap, gx: number, gz: number, core: number, soft: number, v: number, lo: number, hi: number, tag: number) {
  if (v <= 0) return
  const inv = 1 / map.cell
  const rad = core + soft
  const r2 = rad * rad
  const cx = (gx - map.x0) * inv
  const cz = (gz - map.z0) * inv
  const rc = rad * inv
  const i0 = Math.max(0, Math.floor(cx - rc))
  const i1 = Math.min(map.n - 1, Math.ceil(cx + rc))
  const j0 = Math.max(0, Math.floor(cz - rc))
  const j1 = Math.min(map.n - 1, Math.ceil(cz + rc))
  grow(map.drawn, i0, j0, i1, j1)
  for (let j = j0; j <= j1; j++) {
    const ez = (j + 0.5) * map.cell + map.z0 - gz
    for (let i = i0; i <= i1; i++) {
      const ex = (i + 0.5) * map.cell + map.x0 - gx
      const e2 = ex * ex + ez * ez
      if (e2 >= r2) continue
      const o = j * map.n + i
      const a = v * Math.min(1, (rad - Math.sqrt(e2)) / soft)
      if (map.oa[o] <= 0.01) {
        map.lo[o] = lo
        map.hi[o] = hi
        map.owner[o] = tag
        map.oa[o] = a
        continue
      }
      if (lo < map.lo[o]) map.lo[o] = lo
      if (hi > map.hi[o]) map.hi[o] = hi
      if (a > map.oa[o]) {
        map.oa[o] = a
        map.owner[o] = tag
      }
    }
  }
}

/** Parts of a caster whose shadow would stretch further than this (times its own distance) cast none. */
const MAX_STRETCH = 6

/**
 * A soft round dab of shadow: solid out to `core`, then fading over `soft` more (at least about
 * a map cell, so thin strokes slide across the map instead of popping cell to cell). Keeps the
 * darkest.
 */
function dab(map: ShadowMap, gx: number, gz: number, core: number, soft: number, v: number) {
  if (v <= 0) return
  const inv = 1 / map.cell
  const rad = core + soft
  const r2 = rad * rad
  const cx = (gx - map.x0) * inv
  const cz = (gz - map.z0) * inv
  const rc = rad * inv
  const i0 = Math.max(0, Math.floor(cx - rc))
  const i1 = Math.min(map.n - 1, Math.ceil(cx + rc))
  const j0 = Math.max(0, Math.floor(cz - rc))
  const j1 = Math.min(map.n - 1, Math.ceil(cz + rc))
  grow(map.drawn, i0, j0, i1, j1)
  for (let j = j0; j <= j1; j++) {
    const ez = (j + 0.5) * map.cell + map.z0 - gz
    for (let i = i0; i <= i1; i++) {
      const ex = (i + 0.5) * map.cell + map.x0 - gx
      const e2 = ex * ex + ez * ez
      if (e2 >= r2) continue
      const o = j * map.n + i
      const a = v * Math.min(1, (rad - Math.sqrt(e2)) / soft)
      if (a > map.occ[o]) map.occ[o] = a
    }
  }
}

/** How much of light reaches ground point (x, z) through this map: 0 lit .. 1 in full shadow. */
export function shadowAt(map: ShadowMap, x: number, z: number): number {
  const fx = (x - map.x0) / map.cell - 0.5
  const fz = (z - map.z0) / map.cell - 0.5
  const i = Math.floor(fx)
  const j = Math.floor(fz)
  if (i < 0 || j < 0 || i >= map.n - 1 || j >= map.n - 1) return 0
  const tx = fx - i
  const tz = fz - j
  const o = j * map.n + i
  const a = map.occ[o] + (map.occ[o + 1] - map.occ[o]) * tx
  const b = map.occ[o + map.n] + (map.occ[o + map.n + 1] - map.occ[o + map.n]) * tx
  return a + (b - a) * tz
}

/**
 * How shadowed a thing standing at (x, z), at height y, is through this map: 0 lit .. 1 in full
 * shadow. `tag` is the thing's own (its own shadow doesn't count).
 */
export function shadowOnObject(map: ShadowMap, x: number, z: number, y: number, tag: number): number {
  const fx = (x - map.x0) / map.cell - 0.5
  const fz = (z - map.z0) / map.cell - 0.5
  const i = Math.floor(fx)
  const j = Math.floor(fz)
  if (i < 0 || j < 0 || i >= map.n - 1 || j >= map.n - 1) return 0
  const at = (o: number) => {
    const a = map.oa[o]
    if (a <= 0.01 || (tag && map.owner[o] === tag)) return 0
    // soft at the top and bottom of the band (a unit or so)
    return a * Math.min(1, Math.max(0, (map.hi[o] - y) / 1.2 + 0.5)) * Math.min(1, Math.max(0, (y - map.lo[o]) / 1.2 + 0.5))
  }
  const tx = fx - i
  const tz = fz - j
  const o = j * map.n + i
  const a = at(o) + (at(o + 1) - at(o)) * tx
  const b = at(o + map.n) + (at(o + map.n + 1) - at(o + map.n)) * tx
  return a + (b - a) * tz
}

/** The shadow maps of every light, baked and cached. */
export class ShadowMaps {
  statics: Silhouette[] = []
  dynamics: Silhouette[] = []
  /**
   * Milliseconds a frame may spend rebaking the moon's shadows as it moves (the rest waits for the
   * next frame). Scripts set it to Infinity: then a frame's pixels don't depend on the clock.
   */
  farBudget = 2
  /** Bumped when the static silhouettes change (the static layer was rebuilt). */
  version = 0
  private cache = new Map<
    string,
    { key: string; base: ShadowMap; mid: ShadowMap | null; settled: number; map: ShadowMap; moving: number; laid: number[] | null; used: number }
  >()
  /** Each moving caster's pose last frame (by its tag), and for how many frames it's held it. */
  private poses = new Map<string, { print: number; held: number }>()
  /** This frame's moving casters, as noted (the list is new each frame), and which are settled. */
  private noted: Silhouette[] | null = null
  private print = new Map<Silhouette, { print: number; settled: boolean }>()
  private frame = 0

  /**
   * Note this frame's moving casters: each one's pose, and whether it's settled (unchanged for
   * half a second: the fire, the knight and the woodpile mostly are, a shroomfolk between walks).
   */
  private note() {
    if (this.noted === this.dynamics) return
    this.noted = this.dynamics
    // maps no light has used for a couple of seconds go (a burnt-out stick's, a size it burned past)
    if (++this.frame % 60 === 0) for (const [name, c] of this.cache) if (this.frame - c.used > 120) this.cache.delete(name)
    this.print.clear()
    const seen = new Map<number, number>()
    const poses = new Map<string, { print: number; held: number }>()
    for (const s of this.dynamics) {
      const k = seen.get(s.tag) ?? 0
      seen.set(s.tag, k + 1)
      const id = `${s.tag}:${k}`
      const print = fingerprint(0x811c9dc5, s)
      const was = this.poses.get(id)
      const held = was && was.print === print ? was.held + 1 : 0
      poses.set(id, { print, held })
      this.print.set(s, { print, settled: s.tag !== 0 && held >= SETTLED })
    }
    this.poses = poses
  }

  private far: { key: string; dir: number[]; base: ShadowMap; map: ShadowMap } | null = null
  /** The next bake of the still things for a far light, done a little each frame (so it never stalls one). */
  private farNext: { key: string; dir: number[]; base: ShadowMap; done: number } | null = null

  /**
   * The map for a far light from direction `dir` (the moon), over the whole clearing. The still
   * things are baked again only when the direction has turned a step, and that bake is spread
   * over frames (about 2ms each) while the last one stays in use: the shadows trail the moon by a
   * few frames, which nobody sees. Moving things are laid on top each frame, from where it is now.
   */
  farMap(dir: readonly number[]): ShadowMap {
    const step = (v: number) => Math.round(v * 60) / 60
    const d = [step(dir[0]), step(dir[1]), step(dir[2])]
    const key = `${this.version}|${d.join(',')}`
    const cell = 2
    const n = 210 // 420 world units square: the whole wood
    const fresh = () => newMap(-210, -200, cell, n)
    if (!this.far || this.far.key.split('|')[0] !== String(this.version)) {
      // nothing usable yet (or the still things changed): bake it all now
      const base = fresh()
      for (const s of this.statics) splatFar(base, d, s)
      this.far = { key, dir: d, base, map: fresh() }
      this.farNext = null
    } else if (this.far.key !== key) {
      if (this.farNext?.key !== key) this.farNext = { key, dir: d, base: fresh(), done: 0 }
      const next = this.farNext
      const t0 = performance.now()
      while (next.done < this.statics.length && (next.done % 8 !== 0 || performance.now() - t0 < this.farBudget))
        splatFar(next.base, next.dir, this.statics[next.done++])
      if (next.done >= this.statics.length) {
        this.far = { key, dir: next.dir, base: next.base, map: this.far.map }
        this.farNext = null
      }
    }
    const c = this.far
    copyMap(c.map, c.base)
    for (const s of this.dynamics) splatFar(c.map, c.dir, s)
    return c.map
  }

  /** The map for light `l` this frame (static bake from the cache, moving things laid on top). */
  mapFor(l: Light): ShadowMap {
    // the map's size steps with the light's reach, so a flickering fire doesn't rebake
    const half = Math.min(120, Math.ceil((l.radius * 1.2) / 16) * 16)
    const cell = Math.max(0.5, (2 * half) / 220)
    const n = Math.ceil((2 * half) / cell)
    const key = `${this.version}|${l.x.toFixed(1)}|${(l.shadowY ?? l.y).toFixed(1)}|${l.z.toFixed(1)}|${half}`
    // one per size: a flickering fire steps back and forth between two sizes, and keeps both baked
    const name = `${l.name ?? `${l.x},${l.z}`}|${half}`
    // the moving things it lights, as they are this frame (where, and in what pose). Only those
    // within its full light: one further off throws its shadow where there's only the faint
    // spill (under 1% of it), and a low light (a burning stick on the ground) stretches every
    // shadow far, so they'd cost the most for the least
    this.note()
    const lit = this.dynamics.filter((s) => near(l, s, half) && Math.hypot(s.x - l.x, s.z - l.z) < l.radius * 1.2 + s.r)
    // those settled go in a middle layer, kept until one of them moves (or another settles); the
    // map is that with the rest laid on top, again only when one of them has moved
    const settled = lit.filter((s) => this.print.get(s)!.settled)
    const moving = lit.filter((s) => !this.print.get(s)!.settled)
    const hash = (list: Silhouette[]) => list.reduce((h, s) => Math.imul(h ^ this.print.get(s)!.print, 0x01000193), 0x811c9dc5)
    const still = hash(settled)
    const now = hash(moving)
    let c = this.cache.get(name)
    if (!c || c.key !== key) {
      const base = newMap(l.x - (n * cell) / 2, l.z - (n * cell) / 2, cell, n)
      for (const s of this.statics) if (near(l, s, half)) splat(base, l, s)
      c = { key, base, mid: null, settled: ~still, map: newMap(base.x0, base.z0, cell, n), moving: ~now, laid: null, used: 0 }
      this.cache.set(name, c)
    }
    c.used = this.frame
    if (c.settled !== still) {
      c.settled = still
      c.moving = ~now // (the map is laid again on the new middle)
      c.laid = null
      if (settled.length) {
        c.mid ??= newMap(c.base.x0, c.base.z0, cell, n)
        copyMap(c.mid, c.base)
        for (const s of settled) splat(c.mid, l, s)
      } else c.mid = null
    }
    // the same as last frame: the map stands as it is
    if (c.moving === now) return c.map
    c.moving = now
    copyMap(c.map, c.mid ?? c.base)
    c.map.drawn = noBox()
    for (const s of moving) splat(c.map, l, s)
    // what changed: where the moving things' shadows were last frame, and where they are now
    const was = c.laid
    c.laid = c.map.drawn
    if (was) {
      const d = [...was]
      grow(d, c.laid[0], c.laid[1], c.laid[2], c.laid[3])
      c.map.dirty = d
    }
    return c.map
  }
}

/** Frames a moving caster must hold the same pose to count as settled (half a second). */
const SETTLED = 30

/** Fold a moving caster (where it stands, its pose) into a running hash. */
function fingerprint(h: number, s: Silhouette): number {
  const mix = (v: number) => (h = Math.imul(h ^ v, 0x01000193))
  mix(Math.round(s.x * 256))
  mix(Math.round(s.z * 256))
  mix(Math.round(s.ox * 256))
  mix(Math.round(s.s * 256))
  mix(s.tag)
  for (let k = 0; k < s.runs.length; k++) mix(s.runs[k])
  return h
}

const near = (l: Light, s: Silhouette, half: number) => Math.abs(s.x - l.x) < half && Math.abs(s.z - l.z) < half
