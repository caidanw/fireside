/**
 * The frame's pixel buffers: everything a pixel knows (colour, depth, world position, normal...),
 * the emissive layer over it, and copying them by bands of rows. See renderer.ts for the rules.
 */
import { type Color } from '../util'
import { H, N, W } from '../world'

/**
 * Composite an emissive into one pixel of a layer (straight alpha), over or under what's
 * there by depth, or (`add`, for light like flames) added to it. The pixel keeps the nearer
 * depth. Colours may go above 1 where light piles up; the output clamps.
 */
export function over(
  R: Float32Array,
  G: Float32Array,
  Bl: Float32Array,
  A: Float32Array,
  BW: Float32Array,
  D: Float32Array,
  i: number,
  c: Color,
  a: number,
  bloom: number,
  depth: number,
  add = false,
) {
  const ea = A[i]
  if (add && ea > 0) {
    // light adds up: overlapping flames get hotter, whatever order they're drawn in
    const oa = Math.min(1, ea + a * (1 - ea))
    R[i] = (R[i] * ea + c[0] * a) / oa
    G[i] = (G[i] * ea + c[1] * a) / oa
    Bl[i] = (Bl[i] * ea + c[2] * a) / oa
    BW[i] = Math.max(BW[i], bloom)
    A[i] = oa
    if (depth > D[i]) D[i] = depth
    return
  }
  if (ea <= 0) {
    R[i] = c[0]
    G[i] = c[1]
    Bl[i] = c[2]
    A[i] = a
    BW[i] = bloom
    D[i] = depth
    return
  }
  const front = depth >= D[i]
  const ta = front ? a : ea
  const ba = front ? ea : a
  const out = ta + ba * (1 - ta)
  if (out <= 0) return
  const wt = ta / out
  const wb = 1 - wt
  R[i] = front ? c[0] * wt + R[i] * wb : R[i] * wt + c[0] * wb
  G[i] = front ? c[1] * wt + G[i] * wb : G[i] * wt + c[1] * wb
  Bl[i] = front ? c[2] * wt + Bl[i] * wb : Bl[i] * wt + c[2] * wb
  BW[i] = front ? bloom * wt + BW[i] * wb : BW[i] * wt + bloom * wb
  A[i] = out
  if (front) D[i] = depth
}

/** Depth of the empty sky: behind everything. */
export const SKY_DEPTH = -1e9

/** Depth of the bare ground: anything standing on it is in front. */
export const GROUND_DEPTH = -1e8

/** Light-culling tiles: 32x32 pixels. */
export const TILE_BITS = 5

export const TILES_X = Math.ceil(W / (1 << TILE_BITS))

export const TILES = TILES_X * Math.ceil(H / (1 << TILE_BITS))

export type Buf = ReturnType<typeof makeBuf>

export function makeBuf() {
  const f = () => new Float32Array(N)
  const u = () => new Uint8Array(N)
  return {
    // albedo + coverage; obj = covered by an object (not bare ground)
    r: f(),
    g: f(),
    b: f(),
    a: u(),
    obj: u(),
    // world position the pixel came from, and its depth
    kx: f(),
    kz: f(),
    ky: f(),
    dep: f(),
    // surface normal, screen space (x right, y up, z toward viewer); nz = 0 means none
    nx: f(),
    ny: f(),
    nz: f(),
    // static object region (for normal generation), material micro height and its weight
    id: new Int32Array(N),
    mh: f(),
    mw: f(),
    // specular strength (metal gleams)
    sp: f(),
    // how much the pixel glints in the moonlight (foliage speckles)
    gl: f(),
    // which hoverable thing this pixel belongs to (0 = nothing)
    hv: new Int32Array(N),
    // planar reflection (what the pool mirrors at this pixel)
    rr: f(),
    rg: f(),
    rb: f(),
    ra: u(),
    rkx: f(),
    rkz: f(),
    rky: f(),
    rdep: f(), // depth of whatever the reflection shows
    rnx: f(),
    rny: f(),
    rnz: f(),
    rsp: f(),
    rhv: new Int32Array(N),
    // unlit background (sky)
    bgr: f(),
    bgg: f(),
    bgb: f(),
    // open sky (1) or something in the background standing in front of it (the ridge, far trees)
    sky: u(),
    pool: u(),
  }
}

export function copyBuf(d: Buf, s: Buf) {
  for (const k in s) (d[k as keyof Buf] as Float32Array).set(s[k as keyof Buf])
}

/** An emissive layer (rules 3, 5, 6 at the top of the file), empty: nothing glowing, everything at sky depth. */
export function makeFx() {
  const fx = {
    r: new Float32Array(N),
    g: new Float32Array(N),
    b: new Float32Array(N),
    a: new Float32Array(N),
    rr: new Float32Array(N),
    rg: new Float32Array(N),
    rb: new Float32Array(N),
    ra: new Float32Array(N),
    // how much each emissive pixel feeds the bloom (0 = none)
    bw: new Float32Array(N),
    rbw: new Float32Array(N),
    dep: new Float32Array(N),
    rdep: new Float32Array(N),
    hv: new Int32Array(N),
  }
  fx.dep.fill(SKY_DEPTH)
  fx.rdep.fill(SKY_DEPTH)
  return fx
}

/** The frame is tracked in bands of rows (8 rows each): what moving things touched, so only that is restored and uploaded. */
export const BAND_BITS = 3

export const BANDS = Math.ceil(H / (1 << BAND_BITS))

/** Copy only the marked bands of rows from one buffer set to another. */
export function copyBands(
  d: Record<string, ArrayLike<number> & { set(a: ArrayLike<number>, o: number): void }>,
  s: Record<string, { subarray(a: number, b: number): ArrayLike<number> }>,
  bands: Uint8Array,
) {
  for (let b = 0; b < BANDS;) {
    if (!bands[b]) {
      b++
      continue
    }
    let e = b
    while (e < BANDS && bands[e]) e++
    const a = (b << BAND_BITS) * W
    const z = Math.min(H, e << BAND_BITS) * W
    for (const k in s) d[k].set(s[k].subarray(a, z), a)
    b = e
  }
}
