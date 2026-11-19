/**
 * The scene without a browser: a seeded world and the renderer's CPU path, for scripts (run them
 * with scripts/run.mjs). The game's modules are imported after the random numbers are seeded and a
 * stand-in document exists, so a seed always gives the same night and the same pixels.
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

/** Make Math.random repeatable from a seed. */
function seedRandom(seed: number) {
  let s = seed >>> 0 || 1
  Math.random = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
}

/** Just enough of a document for the renderer: 2D canvases that draw nothing, and no WebGL (so it lights on the CPU). */
function fakeCanvas() {
  // every call answers with itself, so gradients and the like work too
  const ctx: object = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'createImageData'
          ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
          : key === 'measureText'
            ? () => ({ width: 0 })
            : () => ctx,
      set: () => true,
    },
  )
  const canvas = () => ({ width: 0, height: 0, style: {}, getContext: (type: string) => (type === '2d' ? ctx : null), addEventListener() {} })
  ;(globalThis as { document?: unknown }).document = { createElement: canvas }
  return canvas()
}

export async function headless(seed: number) {
  seedRandom(seed)
  const canvas = fakeCanvas()
  const { Renderer } = await import('../src/render/renderer')
  const sim = await import('../src/sim')
  const { settings } = await import('../src/engine/settings')
  const { moonTiming } = await import('../src/moon')
  settings.gpu = false
  const world = sim.createWorld()
  const renderer = new Renderer(canvas as never)
  renderer.shadows.farBudget = Infinity // the same pixels whatever the machine's speed
  /** Run the world on, a sixtieth of a second at a time (calling `each` after every tick). */
  const run = (seconds: number, each?: () => void) => {
    for (let i = 0; i < seconds * 60; i++) {
      sim.step(world, 1 / 60, renderer.isOpenWater)
      each?.()
    }
  }
  /** Draw the world as it is now. */
  const frame = () => {
    renderer.render(world)
    return renderer.snapshot()
  }
  return { world, renderer, sim, settings, moonTiming, run, frame }
}

export type Snapshot = Awaited<ReturnType<typeof headless>>['renderer'] extends { snapshot(): infer S } ? S : never

/** A frame's lit image as 8-bit RGB, 640x360. */
export function rgb(snap: Snapshot): Uint8Array {
  const { r, g, b } = snap.lit
  const out = new Uint8Array(r.length * 3)
  for (let i = 0; i < r.length; i++) {
    out[i * 3] = Math.min(255, Math.max(0, r[i]) * 255)
    out[i * 3 + 1] = Math.min(255, Math.max(0, g[i]) * 255)
    out[i * 3 + 2] = Math.min(255, Math.max(0, b[i]) * 255)
  }
  return out
}

/** A fingerprint of a frame, lit image and glow layer both: equal hashes, identical pixels. */
export function hashFrame(snap: Snapshot): string {
  const h = createHash('sha256')
  for (const plane of [snap.lit.r, snap.lit.g, snap.lit.b, snap.glow.r, snap.glow.g, snap.glow.b, snap.glow.a]) h.update(new Uint8Array(plane.buffer))
  return h.digest('hex').slice(0, 16)
}

/** An RGB image: its pixels and size. */
export interface Image {
  data: Uint8Array
  w: number
  h: number
}

export function crop(img: Image, x: number, y: number, w: number, h: number): Image {
  const data = new Uint8Array(w * h * 3)
  for (let r = 0; r < h; r++) data.set(img.data.subarray(((y + r) * img.w + x) * 3, ((y + r) * img.w + x + w) * 3), r * w * 3)
  return { data, w, h }
}

/** Scale up by a whole number, each pixel a k x k block (pixel art stays crisp). */
export function scale(img: Image, k: number): Image {
  const w = img.w * k
  const h = img.h * k
  const data = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (((y / k) | 0) * img.w + ((x / k) | 0)) * 3
      data.set(img.data.subarray(s, s + 3), (y * w + x) * 3)
    }
  return { data, w, h }
}

/** Write an RGB image as a PNG (zlib and a CRC are all a PNG needs). */
export function writePng(path: string, img: Image) {
  const chunk = (type: string, body: Uint8Array) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.w, 0)
  ihdr.writeUInt32BE(img.h, 4)
  ihdr[8] = 8 // bits per channel
  ihdr[9] = 2 // RGB
  const rows = Buffer.alloc((img.w * 3 + 1) * img.h)
  for (let y = 0; y < img.h; y++) rows.set(img.data.subarray(y * img.w * 3, (y + 1) * img.w * 3), y * (img.w * 3 + 1) + 1)
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ])
  writeFileSync(path, png)
}
