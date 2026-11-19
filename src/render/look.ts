/** The colours and lights the renderer draws with: glows, flames, the sky, the clouds and the moon's disc. */
import { MOON_R } from '../moon'
import { clamp, hex, mix, rngFrom, vnoise, type Color } from '../util'
import { HORIZON, RES, W } from '../world'

/** Screen spots the tree crowns keep clear of: the moon, and the top of the trigon stone. */
export const MOON_AT = [170 * RES, 16 * RES] // the moon's centre (MOON_DISC)

/**
 * How much cloud covers this sky pixel (0..1): drifting value noise, thicker as the cover
 * rises, in flat bands like the rest of the art. (gpu.ts cloudAt() ports this exactly.)
 */
export function cloudAt(x: number, y: number, t: number, cover: number): number {
  if (cover <= 0) return 0
  const n = 0.6 * vnoise(x * 0.012 + t * 0.02, y * 0.035) + 0.4 * vnoise(x * 0.031 - t * 0.013, y * 0.08 + 3)
  const d = clamp((n - (1 - cover) * 0.75 - 0.2) * 3.2)
  return Math.floor(d * 4) / 4
}

/** The clouds: a pale moonlit rim at their edges, a dark body (before the ambient and any flash). */
export const CLOUD_RIM = [0.17, 0.19, 0.24]

export const CLOUD = [0.065, 0.075, 0.095]

/** A lightning flash's colour. */
export const FLASH = [0.5, 0.55, 0.7]

export const FLAME = ['#a3311b', '#e0612a', '#ffb347', '#fff1c1'].map(hex)

export const GLOW = {
  cap: hex('#9ff5e4'),
  window: hex('#ffcf7a'),
  inside: hex('#b8743a'),
  lantern: [hex('#ffd27a'), hex('#ffb347'), hex('#ff9a3c')],
  rune: hex('#8ff0e0'),
  foxfire: hex('#b9a2f5'),
  foxfireD: hex('#8a70d8'),
  memorial: hex('#b8fff0'),
  candle: hex('#ffd27a'),
  eye: hex('#e8d78a'),
  firefly: hex('#d8f27a'),
  zzz: hex('#c9d6e8'),
  note: hex('#f2d39a'),
  croak: hex('#e8e0b8'),
  star: hex('#e9e3d4'),
  ripple: hex('#aabed8'),
  ember: hex('#ff8a3a'),
  smoke: hex('#8a8a92'),
  dust: hex('#9c8a6a'),
  glint: hex('#e8c89a'),
  carving: hex('#ff9a4a'),
}

/** What colour each asset's glowing chars light up in (so the editor previews them as the scene does). */
export const GLOW_TINT: Record<string, Color> = {
  shroomfolk: GLOW.cap,
  keeper: GLOW.cap,
  glowcap: GLOW.memorial,
  lanternPost: GLOW.lantern[1],
  hut: GLOW.window,
  owl: GLOW.eye,
  antler: GLOW.carving,
  crook: GLOW.carving,
  key: GLOW.carving,
}

/** Fire light comes from a little above the logs. */
export const FIRE_Y = 6

/** Toward the viewer: the camera sits low, looking a little down into the clearing. */
export const VIEW = [0, 0.3, 0.95]

export const unit = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z) || 1
  return [x / l, y / l, z / l]
}

export const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** The low light the moon's craters keep their shading by near full: from the upper left. */
export const RELIEF_LIGHT = unit(-0.55, 0.5, 0.67)

/** The moon's soft key light comes from straight overhead (a little toward the viewer). */
export const MOON_KEY = unit(0.1, 1, 0.35)

/** How the moon lights the scene if families.json doesn't say. */
export const MOONLIGHT = { fill: 0.7, key: 0.25, highlights: 0.5, shadows: 0.3 }

/** The night sky's colour at a screen row (darkest overhead). */
export const skyAt = (y: number): Color => {
  const t = clamp(y / (72 * RES))
  return mix(hex('#04050a'), hex('#1b2535'), t * t)
}

/** The moon's disc (screen pixels): centre and radius. Nothing in the sky shows through it. */
export const MOON_DISC = { x: 170 * RES, y: 16 * RES, r: MOON_R, up: true }

export const inMoon = (x: number, y: number) => MOON_DISC.up && Math.hypot(x - MOON_DISC.x, y - MOON_DISC.y) <= MOON_DISC.r + 1

/** The stars: only ever in open sky (the compositor also skips any that land on the treeline). */
export const STARS = Array.from({ length: 120 }, (_, i) => {
  const r = rngFrom(i * 77 + 5)
  return { x: (r() * W) | 0, y: (r() * (HORIZON - 6)) | 0, b: 0.3 + r() * 0.7, ph: r() * 6 }
})
