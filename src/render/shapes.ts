/** The shapes of things the renderer draws from code (and the art's pieces it reads): pixel geometry and looks. */
import { DATA, SPRITES, type FoliageDepth, type Highlights, type Surface } from '../art/art'
import { HUT, LANTERN_POST, STICK, type PropArt } from '../art/props'
import { MUSH_CAPS, type Rows } from '../art/sprites'
import { type Mush } from '../sim'
import { hash, type Color } from '../util'
import { H, N, POOL_MAX, PROPS, REEDS, RES, TREES, TUFTS, W, inPool, project, type Relic } from '../world'
import { Buf } from './frame'
import { textureAt } from './materials'
import { lightness } from './normals'

/** The owl (sprite data): a small dark body with ear tufts, perched; its glowing chars are its eyes. */
export const OWL = SPRITES.owl

/** The tree the owl perches in: one at the edge of the clearing, on the left. */
export const owlTree = () =>
  TREES.reduce<(typeof TREES)[number] | null>(
    (best, t) => (Math.hypot(t.x + 78, t.z + 42) < (best ? Math.hypot(best.x + 78, best.z + 42) : 1e9) ? t : best),
    null,
  )

/** Bats, wings up and wings down. */
export const BAT: string[][] = [
  ['b...b', 'bb.bb', '.bbb.'],
  ['.....', 'bbbbb', 'b.b.b'],
]

/** A round lobe of foliage, in screen pixels. */
export interface Lobe {
  cx: number
  cy: number
  rx: number
  ry: number
}

/** How a family's surface is textured (data/families.json): smooth if it isn't there. */
export const surf = (family: string, part: string): Surface => DATA.families[family]?.surfaces[part] ?? { texture: 'none', relief: 0 }

/** A foliage family's highlights (all of them, as first drawn, if it doesn't say). */
export const highlights = (family: string): Highlights => DATA.families[family]?.highlights ?? { amount: 1, strength: 1, glint: 1 }

/** That surface's texture height at a pixel. */
export const texAt = (family: string, part: string, px: number, py: number, seed: number) => textureAt(surf(family, part).texture, px, py, seed)

export interface Foliage {
  /** Its texture (leaves) and how strongly it bumps the light. */
  surface: Surface
  /** How many pale speckles and rim dots, how pale, and how much they glint. */
  highlights: Highlights
  /** Its depth: leaf clumps, painted depth, lighter leaves, a sheen (none if unset: soft flat domes). */
  depth?: FoliageDepth
  x: number
  z: number
  bx: number
  by: number
  s: number
  dep: number
  base: Color
  speck: Color
  dim: Color
  seed: number
  arcs: boolean
  clipY?: number
  /** Per column, the lowest row it reaches (a footprint curving toward you), if not flat at clipY. */
  clipAt?: (px: number) => number
  heightAt: (py: number) => number
}

export const trigonAt = () => {
  const [x, y, s] = project(PROPS.trigon.x, 0, PROPS.trigon.z)
  return [x, y - Math.round(40 * s)]
}

/** Rasterise a filled ellipse; fn gets the pixel and normalised offsets (u, w) in [-1, 1]. */
export function disc(fn: (px: number, py: number, u: number, w: number) => void, cx: number, cy: number, rx: number, ry: number) {
  for (let dy = -ry; dy <= ry; dy++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2)))
    for (let dx = -half; dx <= half; dx++) fn(cx + dx, cy + dy, dx / (rx || 1), dy / (ry || 1))
  }
}

/**
 * The triangle cut into the trigon stone, in screen pixels from its centre: a cut two pixels
 * wide whose sides step one pixel per row, and a thick base.
 */
export const trigonPx = (() => {
  const out: [number, number][] = []
  for (let r = 0; r < 10; r++) for (let k = -r; k <= r; k++) if (r >= 8 || Math.abs(k) >= r - 1) out.push([k, r - 5])
  return out
})()

/** The face inside the carved triangle (for a slight recess and an inner glow). */
export const TRIGON_INSIDE = (() => {
  const out: [number, number][] = []
  for (let r = 2; r < 8; r++) for (let k = -r + 2; k <= r - 2; k++) out.push([k, r - 5])
  return out
})()

/** Pixels just outside the cut (its lip), for a faint halo. */
export const TRIGON_LIP = (() => {
  const taken = new Set([...trigonPx, ...TRIGON_INSIDE].map(([x, y]) => `${x},${y}`))
  const out: [number, number][] = []
  for (const [x, y] of trigonPx) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const key = `${x + dx},${y + dy}`
      if (taken.has(key)) continue
      taken.add(key)
      out.push([x + dx, y + dy])
    }
  }
  return out
})()

/**
 * Bake material micro height into the normals: Sobel slopes of the micro height (plus a
 * little painted lightness), within each object region, tilt its shape normal.
 */
export function bakeMicroDetail(B: Buf) {
  const STRENGTH = 1.6
  const h = new Float32Array(N)
  for (let i = 0; i < N; i++) if (B.id[i]) h[i] = B.mh[i] + 0.6 * (lightness(B.r[i], B.g[i], B.b[i]) - 0.35)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const wgt = B.mw[i]
      if (!B.id[i] || wgt <= 0 || B.nz[i] <= 0) continue
      const at = (dx: number, dy: number) => {
        const j = (y + dy) * W + x + dx
        return B.id[j] === B.id[i] ? h[j] : h[i]
      }
      const sx = (at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)) * 0.125
      const sy = (at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)) * 0.125
      const nx = B.nx[i] - sx * STRENGTH * wgt
      const ny = B.ny[i] + sy * STRENGTH * wgt
      const nz = B.nz[i]
      const l = Math.hypot(nx, ny, nz) || 1
      B.nx[i] = nx / l
      B.ny[i] = ny / l
      B.nz[i] = nz / l
    }
  }
}

/**
 * The stick art (STICK) turned to any angle: [dx, dy, char] around its anchor. Its columns run
 * along the stick; each row below the top is one pixel further across it (its underside).
 */
export function stickPixels(angle: number): [number, number, string][] {
  const { rows, anchor } = STICK
  const seen = new Set<string>()
  const ca = Math.cos(angle)
  const sa = -Math.sin(angle)
  const thick: [number, number] = Math.abs(ca) >= Math.abs(sa) ? [0, 1] : [1, 0]
  const out: [number, number, string][] = []
  for (let c = 0; c < rows[0].length; c++) {
    const x = Math.round(ca * (c - anchor))
    const y = Math.round(sa * (c - anchor))
    rows.forEach((row, r) => {
      const ch = row[c] ?? '.'
      const key = `${x + thick[0] * r},${y + thick[1] * r}`
      if (ch === '.' || seen.has(key)) return
      seen.add(key)
      out.push([x + thick[0] * r, y + thick[1] * r, ch])
    })
  }
  return out
}

/** The angle a stick is held at (slanted, like a torch), and the far end of a stick at an angle, from its anchor. */
export const HELD_STICK = Math.PI / 2 - 0.4

export function stickTip(angle: number): [number, number] {
  const n = STICK.rows[0].length - 1 - STICK.anchor
  return [Math.round(Math.cos(angle) * n), Math.round(-Math.sin(angle) * n)]
}

/** The hut art's doorway (the chars set back: [k, r] from the hut's foot, and its bottom-left) and its window ([k, r, glow]). */
export function hutOpenings() {
  const { rows, anchor, glow, depth = {}, foot } = HUT
  const door: [number, number][] = []
  const window: [number, number, number][] = []
  let k0 = Infinity
  let r0 = Infinity
  rows.forEach((row, i) =>
    [...row].forEach((ch, c) => {
      const k = c - anchor
      const r = rows.length - 1 - i - foot
      if ((depth[ch] ?? 0) < 0) {
        door.push([k, r])
        k0 = Math.min(k0, k)
        r0 = Math.min(r0, r)
      } else if (glow[ch]) window.push([k, r, glow[ch]])
    }),
  )
  const inside = Math.min(0, ...Object.values(depth))
  const light = Math.max(0, ...Object.entries(glow).map(([ch, g]) => ((depth[ch] ?? 0) < 0 ? g : 0)))
  return { door, window, k0, r0, inside, light }
}

/**
 * The road lantern, cut from its post's art (its hook, the iron 'i', and its glowing glass), and
 * the post without it: the lantern can be lifted off and carried. `dx`/`up`: where the lantern
 * hangs, from the post's foot (its anchor column, and rows up to the lantern's bottom row).
 */
let lanternCache: { rows: Rows; cut: { lantern: PropArt; post: PropArt; dx: number; up: number } } | null = null

export function lanternCut() {
  const P = LANTERN_POST
  if (lanternCache?.rows === P.rows) return lanternCache.cut
  const mine = (ch: string) => ch === 'i' || !!P.glow[ch]
  let r0 = Infinity
  let r1 = -1
  let c0 = Infinity
  let c1 = -1
  P.rows.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (!mine(ch)) return
      r0 = Math.min(r0, r)
      r1 = Math.max(r1, r)
      c0 = Math.min(c0, c)
      c1 = Math.max(c1, c)
    }),
  )
  const anchor = (c1 - c0) >> 1
  const lantern: PropArt = {
    ...P,
    rows: P.rows.slice(r0, r1 + 1).map((row) => [...row.slice(c0, c1 + 1)].map((ch) => (mine(ch) ? ch : '.')).join('')),
    anchor,
    foot: 0,
  }
  const post: PropArt = { ...P, rows: P.rows.map((row) => [...row].map((ch) => (mine(ch) ? '.' : ch)).join('')) }
  const cut = { lantern, post, dx: c0 + anchor - P.anchor, up: P.rows.length - 1 - r1 - P.foot }
  lanternCache = { rows: P.rows, cut }
  return cut
}

/** A tiny z, drifting up from a sleeping hut's chimney. */
/**
 * The little things at the pool's edge that the rising water swallows (or, lily pads, that only
 * float on it): drawn every frame for the current level, so the static layer needn't change.
 */
export const EDGE_TUFTS = TUFTS.filter((t) => inPool(t.x, t.z, POOL_MAX * 1.2))

export const EDGE_REEDS = REEDS.filter((r) => inPool(r.x, r.z, POOL_MAX * 0.98))

/** How many pixels a shroomfolk is off the ground: dancers hop in time, a singer bobs gently, and everyone skips a little in the rain. */
export function mushHop(st: string, moving: boolean, t: number, seed: number, raining: boolean): number {
  if (st === 'dance') return Math.sin(t * 6 * Math.PI + seed * 10) > 0 ? 1 : 0
  if (st === 'sing' && !moving) return Math.sin(t * 3 + seed * 10) > 0.4 ? 1 : 0
  return raining && moving && Math.sin(t * 12 + seed * 10) > 0.6 ? 1 : 0
}

/** Sung notes drifting up from a singer: a quaver and a pair of beamed quavers. */
export const NOTES: [number, number][][] = [
  ['..##', '..#.', '..#.', '###.', '##..'],
  ['.####', '.#..#', '.#..#', '##.##', '##.##'],
].map((rows) => rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === '#' ? [[x, y] as [number, number]] : []))))

export const ZED: [number, number][] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [1, 1],
  [0, 2],
  [1, 2],
  [2, 2],
]

/** Each shroomfolk's cap colour, for good: red, gold or crimson. */
export const capOf = (m: Mush) => MUSH_CAPS[Math.floor(hash(m.seed * 7919, 3) * MUSH_CAPS.length) % MUSH_CAPS.length]

/** States in which shroomfolk sit down once they've arrived. */
export const SITTING: string[] = ['visit', 'keep', 'farewell', 'tend']

/**
 * Where the hut's chimney top is, in layout pixels from its base, for the sleepers' Zs: the
 * topmost pixel of the hut art's stone part (the part with 'k'), wherever it's drawn.
 */
export function hutChimney(): [number, number] {
  const { rows, anchor, foot, parts } = HUT
  const stone = parts.find((p) => p.chars.includes('k'))?.chars ?? 'k'
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < rows[r].length; c++) if (stone.includes(rows[r][c])) return [(c - anchor + 1) / RES, (rows.length - 1 - r - foot) / RES]
  return [9.5, 31]
}

/**
 * The antler crown carved into the tall hearthstone: the same shape as the relic in the fire,
 * three tines over a band and a stem. Screen-pixel offsets from the carving's centre.
 */
export const CROWN_PX: [number, number][] = (() => {
  const rows = [
    'xx...xx...xx',
    'xx...xx...xx',
    'xx...xx...xx',
    '.xx..xx..xx.',
    '..xxxxxxxx..',
    '...xxxxxx...',
    '.....xx.....',
    '.....xx.....',
    '.....xx.....',
    '.....xx.....',
  ]
  const out: [number, number][] = []
  rows.forEach((row, r) => [...row].forEach((ch, c) => ch === 'x' && out.push([c - 6, r - 5])))
  return out
})()

/** The relic planted in the ashes (art in props.ts), and what the hover says about it. */
/** The relics' names (their art is RELIC_ART, live). */
export const RELICS: Record<Relic, { name: string; sub: string }> = {
  crook: { name: 'the kindling crook', sub: 'its coil is warm to the touch' },
  key: { name: 'the ember key', sub: 'nobody remembers the door' },
  antler: { name: 'the old crown', sub: "the forest's gift to the first fire" },
}
