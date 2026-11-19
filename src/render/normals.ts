/**
 * Normal maps for pixel art, generated from the pixels themselves.
 *
 * A TypeScript port of the relief step in Sprite Fusion's sprite-normals
 * (https://github.com/Hugo-Dz/spritefusion-sprite-normals, MIT, Hugo Duprez):
 *
 *   height = log-compressed distance from the silhouette edge   (volume)
 *          + painted lightness, lightly blurred                  (surface detail)
 *   normal = normalize(-dx * strength, dy * strength, 1) from Sobel slopes
 *
 * The one addition is a region map: many objects can share one buffer (the
 * whole static scene), and each region is treated as its own silhouette, so
 * edges between touching objects still read as edges.
 *
 * Output normals are screen space: x right, y up, z toward the viewer.
 */
import { shape, textureAt, type Normal } from './materials'

export interface ReliefSettings {
  shapeRadius: number
  shapeStrength: number
  shapeSoftness: number
  detailStrength: number
  detailScale: number
  normalStrength: number
}

/** The upstream defaults, with detail turned down: our art has a lot of painted texture. */
const RELIEF_DEFAULTS: ReliefSettings = {
  shapeRadius: 4,
  shapeStrength: 1.15,
  shapeSoftness: 1.15,
  detailStrength: 3,
  detailScale: 0.6,
  normalStrength: 2,
}

/** Perceptual lightness (OKLab L) of a linear-ish 0..1 colour. */
export function lightness(r: number, g: number, b: number): number {
  const l = Math.cbrt(0.41222146 * r + 0.53633255 * g + 0.051445995 * b)
  const m = Math.cbrt(0.2119035 * r + 0.6806995 * g + 0.10739696 * b)
  const s = Math.cbrt(0.08830246 * r + 0.28171885 * g + 0.6299787 * b)
  return 0.21045426 * l + 0.7936178 * m - 0.004072047 * s
}

/**
 * Fill nx/ny/nz for every pixel with region > 0. `light` is per-pixel lightness.
 * Pixels with region 0 get nz = 0, meaning "no normal".
 */
export function reliefNormals(
  w: number,
  h: number,
  region: Int32Array,
  light: Float32Array,
  nx: Float32Array,
  ny: Float32Array,
  nz: Float32Array,
  s: ReliefSettings = RELIEF_DEFAULTS,
) {
  const n = w * h
  const same = (i: number, j: number) => region[j] === region[i]

  // 1. distance to the region edge (two-pass chamfer; an approximation of the upstream EDT)
  const dist = new Float32Array(n)
  for (let i = 0; i < n; i++) dist[i] = region[i] ? 1e9 : 0
  const relax = (i: number, x: number, y: number, dx: number, dy: number, cost: number) => {
    const xx = x + dx
    const yy = y + dy
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) return Math.min(dist[i], cost)
    const j = yy * w + xx
    return same(i, j) ? Math.min(dist[i], dist[j] + cost) : Math.min(dist[i], cost)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!region[i]) continue
      dist[i] = relax(i, x, y, -1, 0, 1)
      dist[i] = relax(i, x, y, 0, -1, 1)
      dist[i] = relax(i, x, y, -1, -1, Math.SQRT2)
      dist[i] = relax(i, x, y, 1, -1, Math.SQRT2)
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (!region[i]) continue
      dist[i] = relax(i, x, y, 1, 0, 1)
      dist[i] = relax(i, x, y, 0, 1, 1)
      dist[i] = relax(i, x, y, 1, 1, Math.SQRT2)
      dist[i] = relax(i, x, y, -1, 1, Math.SQRT2)
    }
  }

  // 2. volume: log-compressed inset, so wide shapes dome without becoming towers
  const shape = new Float32Array(n)
  const R = s.shapeRadius
  for (let i = 0; i < n; i++) {
    if (!region[i]) continue
    shape[i] = s.shapeStrength * R * Math.log1p(Math.max(0, dist[i] - 0.5) / R)
  }

  // 3. lightness centred on the scene's range (a constant offset has no normal)
  let lo = 1
  let hi = 0
  for (let i = 0; i < n; i++) {
    if (!region[i]) continue
    lo = Math.min(lo, light[i])
    hi = Math.max(hi, light[i])
  }
  const centred = new Float32Array(n)
  for (let i = 0; i < n; i++) if (region[i]) centred[i] = light[i] - (lo + hi) / 2

  // 4. combine: blurred volume + fine and broad detail, each blurred within its region
  const height = maskedGaussian(shape, region, w, h, s.shapeSoftness)
  const fine = maskedGaussian(centred, region, w, h, s.detailScale)
  const broad = maskedGaussian(centred, region, w, h, s.detailScale * 2)
  for (let i = 0; i < n; i++) if (region[i]) height[i] += s.detailStrength * (0.7 * fine[i] + 0.3 * broad[i])

  // 5. Sobel slopes -> normals (neighbours outside the region read as the centre)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!region[i]) {
        nz[i] = 0
        continue
      }
      const at = (dx: number, dy: number) => {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return height[i]
        const j = yy * w + xx
        return same(i, j) ? height[j] : height[i]
      }
      const dx = (at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)) * 0.125
      const dy = (at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)) * 0.125
      const ox = -dx * s.normalStrength
      const oy = dy * s.normalStrength
      const len = Math.sqrt(ox * ox + oy * oy + 1)
      nx[i] = ox / len
      ny[i] = oy / len
      nz[i] = 1 / len
    }
  }
}

/** Separable gaussian that only mixes pixels of the same region. */
function maskedGaussian(src: Float32Array, region: Int32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)))
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!region[i]) continue
        let sum = 0
        let wt = 0
        for (let t = -r; t <= r; t++) {
          const xx = horizontal ? x + t : x
          const yy = horizontal ? y : y + t
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const j = yy * w + xx
          if (region[j] !== region[i]) continue
          sum += from[j] * k[t + r]
          wt += k[t + r]
        }
        to[i] = sum / wt
      }
    }
  }
  pass(src, tmp, true)
  pass(tmp, out, false)
  return out
}

/** Normals for a char-grid sprite, cached per sprite + palette. */
export interface SpriteNormals {
  w: number
  h: number
  nx: Float32Array
  ny: Float32Array
  nz: Float32Array
}
let spriteCache = new WeakMap<readonly string[], SpriteNormals>()

export function spriteNormals(rows: readonly string[], colorOf: (ch: string) => [number, number, number]): SpriteNormals {
  const hit = spriteCache.get(rows)
  if (hit) return hit
  const pad = 2
  const w = rows[0].length + pad * 2
  const h = rows.length + pad * 2
  const region = new Int32Array(w * h)
  const light = new Float32Array(w * h)
  rows.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (ch === '.') return
      const i = (r + pad) * w + c + pad
      region[i] = 1
      light[i] = lightness(...colorOf(ch))
    }),
  )
  const out = { w, h, nx: new Float32Array(w * h), ny: new Float32Array(w * h), nz: new Float32Array(w * h) }
  reliefNormals(w, h, region, light, out.nx, out.ny, out.nz, { ...RELIEF_DEFAULTS, shapeRadius: 3, detailStrength: 4 })
  spriteCache.set(rows, out)
  return out
}

/**
 * Creature normals from parts, not from the silhouette. Each part is a group of
 * palette chars with a primitive shape (a mushroom cap, a cylinder, a dome);
 * every connected patch of a part gets that shape across its own bounds. The
 * cap is the same pixels in every walk frame, so its lighting holds steady
 * while the legs move (the relief generator re-derived it per frame, and it
 * shimmered).
 */
/**
 * The shapes a part can take. 'lathe' is round like a cylinder, but follows its own outline: each
 * row is as wide as the part is there, and where it widens going down it faces up, where it tucks
 * in it faces down (a swollen foot, a flared lip, a capstone). 'tube' is for thin strokes (tines,
 * sticks, branches) whatever way they run: each pixel faces away from the empty pixels round it,
 * so a stroke two pixels wide is round, and only its inside (if it's wider) faces us.
 */
export type PartKind = 'cap' | 'under' | 'cylinder' | 'dome' | 'flat' | 'lathe' | 'tube'
export interface Part {
  chars: string
  kind: PartKind
  /** How strongly its texture (and its painted light and dark) bump the light (0..1; smooth if unset). */
  relief?: number
  /** Its texture (materials.ts: stone, bark, leaves...); with relief only the painted light and dark if unset. */
  texture?: string
}
/** How much a lathe's rings curve toward us (the scene's soft 3/4: a ring's depth on screen over its width). */
const LATHE_TILT = 0.24
let partCache = new WeakMap<readonly string[], Map<object | null, SpriteNormals>>()

/**
 * Normals from parts. With a palette, parts with relief also get bumps: their texture plus their
 * painted light and dark, baked in the art's own pixels (so the texture moves with a sprite).
 */
export function partNormals(rows: readonly string[], parts: Part[], pal?: Record<string, ArrayLike<number>>): SpriteNormals {
  const cached = partCache.get(rows) ?? new Map<object | null, SpriteNormals>()
  partCache.set(rows, cached)
  const key = parts.some((p) => p.relief) ? (pal ?? null) : null
  const hit = cached.get(key)
  if (hit) return hit
  const pad = 2
  const rw = rows[0].length
  const rh = rows.length
  const w = rw + pad * 2
  const h = rh + pad * 2
  const out = { w, h, nx: new Float32Array(w * h), ny: new Float32Array(w * h), nz: new Float32Array(w * h) }
  const done = new Uint8Array(rw * rh)
  const write = (r: number, c: number, n: Normal) => {
    const i = (r + pad) * w + c + pad
    out.nx[i] = n[0]
    out.ny[i] = n[1]
    out.nz[i] = n[2]
  }
  const groups = [...parts, { chars: '', kind: 'dome' as PartKind }] // the last catches anything unassigned
  for (const part of groups) {
    const inPart = (r: number, c: number) => {
      if (r < 0 || r >= rh || c < 0 || c >= rw) return false
      const ch = rows[r][c]
      if (ch === '.' || done[r * rw + c]) return false
      return part.chars ? part.chars.includes(ch) : true
    }
    for (let r0 = 0; r0 < rh; r0++) {
      for (let c0 = 0; c0 < rw; c0++) {
        if (!inPart(r0, c0)) continue
        // flood one connected patch of this part
        const patch: [number, number][] = []
        const stack: [number, number][] = [[r0, c0]]
        done[r0 * rw + c0] = 1
        while (stack.length) {
          const [r, c] = stack.pop()!
          patch.push([r, c])
          for (const [dr, dc] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            if (!inPart(r + dr, c + dc)) continue
            done[(r + dr) * rw + c + dc] = 1
            stack.push([r + dr, c + dc])
          }
        }
        let x0 = Infinity
        let x1 = -Infinity
        let y0 = Infinity
        let y1 = -Infinity
        for (const [r, c] of patch) {
          x0 = Math.min(x0, c)
          x1 = Math.max(x1, c)
          y0 = Math.min(y0, r)
          y1 = Math.max(y1, r)
        }
        const cx = (x0 + x1) / 2
        const cy = (y0 + y1) / 2
        const hw = Math.max(0.75, (x1 - x0 + 1) / 2)
        const hh = Math.max(0.75, (y1 - y0 + 1) / 2)
        if (part.kind === 'lathe') {
          // each row's own extent (holes inside, like a doorway, don't matter), and how it changes row to row
          const lo = new Map<number, number>()
          const hi = new Map<number, number>()
          for (const [r, c] of patch) {
            lo.set(r, Math.min(lo.get(r) ?? Infinity, c))
            hi.set(r, Math.max(hi.get(r) ?? -Infinity, c))
          }
          const half = (r: number) => (hi.has(r) ? (hi.get(r)! - lo.get(r)! + 1) / 2 : NaN)
          const mid = (r: number) => (lo.get(r)! + hi.get(r)!) / 2
          // widening going down (screen rows), over a few rows so single-pixel steps don't show
          const widen = (r: number) => {
            let sum = 0
            let n = 0
            for (let k = 1; k <= 2; k++) {
              const a = half(r - k)
              const b = half(r + k)
              if (!Number.isNaN(a) && !Number.isNaN(b)) ((sum += (b - a) / (2 * k)), n++)
            }
            return n ? sum / n : 0
          }
          for (const [r, c] of patch) {
            const w = Math.max(0.75, half(r))
            const u = Math.max(-0.98, Math.min(0.98, (c - mid(r)) / w))
            const z = Math.sqrt(1 - u * u)
            // seen from a little above, each ring round it curves down toward us in the middle: this
            // pixel's ring meets the outline a little higher up, at its edges, so read the widening there
            const edge = Math.round(r - LATHE_TILT * w * z)
            const up = 0.8 * widen(lo.has(edge) ? edge : r) // > 0: widening going down, so it faces up (a little softened: pixel outlines step)
            const l = Math.hypot(u, up, z) || 1
            write(r, c, [u / l, up / l, z / l])
          }
          continue
        }
        if (part.kind === 'tube') {
          const inside = (r: number, c: number) => r >= 0 && r < rh && c >= 0 && c < rw && rows[r][c] !== '.' && part.chars.includes(rows[r][c])
          for (const [r, c] of patch) {
            let ex = 0
            let ey = 0
            for (let dr = -1; dr <= 1; dr++)
              for (let dc = -1; dc <= 1; dc++)
                if ((dr || dc) && !inside(r + dr, c + dc)) {
                  ex += dc
                  ey -= dr // up is +y
                }
            const l = Math.hypot(ex, ey)
            const tilt = l ? 0.75 : 0
            write(r, c, l ? [(ex / l) * tilt, (ey / l) * tilt, Math.sqrt(1 - tilt * tilt)] : [0, 0, 1])
          }
          continue
        }
        for (const [r, c] of patch) {
          const u = (c - cx) / hw
          const v = (r - cy) / hh
          const n =
            part.kind === 'cap'
              ? shape.cap(u, v * 0.8 - 0.1)
              : part.kind === 'under'
                ? ([u * 0.4, -0.85, 0.35] as Normal)
                : part.kind === 'cylinder'
                  ? shape.cylinder(u)
                  : part.kind === 'flat'
                    ? shape.flat
                    : shape.dome(u, v)
          write(r, c, n)
        }
      }
    }
  }
  if (key !== null || parts.some((p) => p.relief)) bakeTexture(rows, parts, pal, out, pad)
  cached.set(key, out)
  return out
}

/** Bump part normals with each part's texture and painted light and dark (Sobel slopes of the height, within the part). */
function bakeTexture(rows: readonly string[], parts: Part[], pal: Record<string, ArrayLike<number>> | undefined, out: SpriteNormals, pad: number) {
  const STRENGTH = 1.6
  const rw = rows[0].length
  const rh = rows.length
  const owner = new Int16Array(rw * rh).fill(-1)
  const height = new Float32Array(rw * rh)
  const partOf = new Map<string, number>()
  for (let r = 0; r < rh; r++)
    for (let c = 0; c < rw; c++) {
      const ch = rows[r][c] ?? '.'
      if (ch === '.') continue
      if (!partOf.has(ch))
        partOf.set(
          ch,
          parts.findIndex((p) => p.chars.includes(ch)),
        )
      const k = partOf.get(ch)!
      owner[r * rw + c] = k
      if (k < 0 || !parts[k].relief) continue
      const col = pal?.[ch]
      const painted = col ? 0.6 * (lightness(col[0], col[1], col[2]) - 0.35) : 0
      height[r * rw + c] = textureAt(parts[k].texture, c, r, k * 17 + 3) + painted
    }
  for (let r = 0; r < rh; r++)
    for (let c = 0; c < rw; c++) {
      const i = r * rw + c
      const k = owner[i]
      const wgt = k < 0 ? 0 : (parts[k].relief ?? 0)
      if (wgt <= 0) continue
      const o = (r + pad) * out.w + c + pad
      if (out.nz[o] <= 0) continue
      if (parts[k].texture === 'ringmail') {
        // dithered normals: alternate pixels tip toward the upper left and the lower right (a bump this fine would cancel in the Sobel)
        const tilt = (r + c) & 1 ? -0.55 * wgt : 0.55 * wgt
        const nx = out.nx[o] - tilt
        const ny = out.ny[o] + tilt
        const l = Math.hypot(nx, ny, out.nz[o]) || 1
        out.nx[o] = nx / l
        out.ny[o] = ny / l
        out.nz[o] /= l
        continue
      }
      const at = (dc: number, dr: number) => {
        const rr = r + dr
        const cc = c + dc
        return rr >= 0 && rr < rh && cc >= 0 && cc < rw && owner[rr * rw + cc] === k ? height[rr * rw + cc] : height[i]
      }
      const sx = (at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)) * 0.125
      const sy = (at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)) * 0.125
      const nx = out.nx[o] - sx * STRENGTH * wgt
      const ny = out.ny[o] + sy * STRENGTH * wgt
      const l = Math.hypot(nx, ny, out.nz[o]) || 1
      out.nx[o] = nx / l
      out.ny[o] = ny / l
      out.nz[o] /= l
    }
}

/** Forget every cached sprite normal map (after the art or its parts change). */
export function forgetNormals() {
  spriteCache = new WeakMap()
  partCache = new WeakMap()
}
