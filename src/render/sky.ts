/** The moon's face: sampled from the moon art, lit by its phase, with craters raised as it waxes full. */
import { DATA, FULL_RELIEF } from '../art/art'
import { MOON_R, moonPlace, moonTiming } from '../moon'
import { type World } from '../sim'
import { clamp, hex, mix, vnoise, type Color } from '../util'
import { type MoonFace } from './gpu'
import { MOON_DISC, RELIEF_LIGHT, dot3, unit } from './look'
import { textureAt } from './materials'
import type { Renderer } from './renderer'
import { surf } from './shapes'

/** Its face for the current look (rebuilt when its texture changes). */
function faceOfMoon(ren: Renderer): MoonFace {
  const face = surf('moon', 'face')
  const key = `${face.texture}|${face.relief}`
  if (ren.moonFace?.key === key) return ren.moonFace
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
      // how much of ren texel the disc covers (4x4 samples), for a soft edge as it glides
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
  return (ren.moonFace = { key, size: D, data, version: (ren.moonFace?.version ?? 0) + 1 })
}

/** Sample the moon's face at screen pixel (x, y) (bilinear, so it moves smoothly): into out = normal xyz, cover, albedo rgb, crater bump. False if it isn't there. */
export function sampleMoon(ren: Renderer, x: number, y: number, out: Float32Array): boolean {
  const F = ren.moonFace
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

/** The moon's clock this frame: where it is, its sun, and the stone turning it and the hush while it's gone. */
export function tickMoon(ren: Renderer, w: World) {
  const at = (ren.moonAt = moonPlace(w.moon))
  // while it's behind the stone: the stone turns it (its carving glows up and fades), and the
  // forest is hushed (eases in, and out again as the moon comes back up)
  const { crossing } = moonTiming()
  const smooth = (v: number) => v * v * (3 - 2 * v)
  const h = w.moon.t - crossing
  ren.hush = h >= 0 ? smooth(clamp(h / 4)) : 1 - smooth(clamp(w.moon.t / 8))
  ren.turning = h >= 0 && h < 10 ? Math.sin((Math.PI * h) / 10) : 0
  MOON_DISC.x = at.x
  MOON_DISC.y = at.y
  MOON_DISC.up = at.up
  faceOfMoon(ren)
  const ph = (at.phase * Math.PI) / 180
  const an = (at.angle * Math.PI) / 180
  ren.moonSun = [Math.cos(an) * Math.sin(ph), Math.sin(an) * Math.sin(ph), Math.cos(ph)]
  ren.earthshine = DATA.families.moon?.sun?.earthshine ?? 0.02
  ren.fullRelief = DATA.families.moon?.sun?.fullRelief ?? FULL_RELIEF
}

/** Light a sampled moon pixel by its sun: how far from the sky behind it toward its face (0..1), banded like the rest of the light. */
export function moonLit(ren: Renderer, m: Float32Array): number {
  const S = ren.moonSun
  const lit = Math.max(0, m[0] * S[0] + m[1] * S[1] + m[2] * S[2])
  // it stays bright right up to its terminator (it isn't a matte ball); the dark side only a hint lighter than the sky
  const band = Math.round(Math.min(1, lit * 2.6) * 4) / 4
  return (ren.earthshine + (1 - ren.earthshine) * band * craters(ren, m[7])) * m[3]
}

/** Near full, the craters keep their shading from a low light (it fades out as the real sun moves round and shades them itself). */
function craters(ren: Renderer, bump: number): number {
  const z = ren.moonSun[2]
  return Math.min(1.3, Math.max(0.4, 1 + ren.fullRelief * bump * z * z))
}
