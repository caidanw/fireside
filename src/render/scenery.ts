/** The still layer: everything that doesn't move, drawn once (trees, bushes, the small things, graves, huts, stones, the pool and its edges), and redrawn when the editor changes it. */
import { DATA } from '../art/art'
import { HUT, PACK, SWORD, seatLog } from '../art/props'
import { clamp, hash, hex, mix, rngFrom, vnoise, type Color } from '../util'
import {
  BUSHES,
  C,
  DETAILS,
  H,
  HEARTHSTONES,
  HORIZON,
  N,
  PADS,
  POOL_MAX,
  PROPS,
  REEDS,
  RES,
  STONE_RING,
  TREES,
  TUFTS,
  UNDERGROWTH,
  W,
  inPool,
  poolMetric,
  project,
  unproject,
  type Bush,
  type Detail,
  type Point,
  type Tree,
} from '../world'
import { Buf, GROUND_DEPTH, SKY_DEPTH } from './frame'
import { tagId } from './labels'
import { MOON_AT, skyAt } from './look'
import { WEIGHT, shape, textureAt, type Normal } from './materials'
import { lightness, reliefNormals } from './normals'
import type { Renderer } from './renderer'
import {
  CROWN_PX,
  EDGE_REEDS,
  EDGE_TUFTS,
  Foliage,
  Lobe,
  TRIGON_INSIDE,
  bakeMicroDetail,
  disc,
  highlights,
  lanternCut,
  surf,
  texAt,
  trigonAt,
  trigonPx,
} from './shapes'

export function buildStatic(ren: Renderer) {
  const B = ren.st
  ren.stillChanged = ren.uploadAll = true
  const ridgeFar = C.ridgeFar
  const ridgeMid = C.ridgeMid
  ren.baked = true
  ren.poolLevel = -1 // recolour the pool after
  for (const k in B) (B[k as keyof Buf] as Float32Array).fill(0)
  B.dep.fill(SKY_DEPTH)
  B.rdep.fill(SKY_DEPTH)
  ren.detailGlows = []
  ren.shadows.statics = []
  ren.shadows.version++
  ren.region = 0
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
      const c = groundCol(gx, gz)
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
    ...TREES.map((t, i) => ({ z: t.z, draw: () => ren.tagged(`tree${i}`, () => ren.casting(B, t.x, t.z, () => drawTree(ren, B, t))) })),
    ...BUSHES.map((b, i) => ({ z: b.z, draw: () => ren.tagged(`bush${i}`, () => ren.casting(B, b.x, b.z, () => drawBush(ren, B, b))) })),
    ...UNDERGROWTH.map((b) => ({ z: b.z, draw: () => ren.tagged('undergrowth', () => drawBush(ren, B, b)) })),
    ...DETAILS.map((d, i) => ({ z: d.z, draw: () => ren.tagged(`detail${i}`, () => ren.casting(B, d.x, d.z, () => drawDetail(ren, B, d))) })),
    ...PROPS.huts.map((h, i) => ({ z: h.z, draw: () => ren.tagged(`hut${i}`, () => ren.casting(B, h.x, h.z, () => drawHut(ren, B, h))) })),
    ...PROPS.graves.map((g, i) => ({ z: g.z, draw: () => ren.tagged('grove', () => ren.casting(B, g.x, g.z, () => drawGrave(ren, B, g, i))) })),
    { z: PROPS.lantern.z, draw: () => ren.tagged('lanternpost', () => drawLanternPost(ren, B, PROPS.lantern)) },
    { z: PROPS.trigon.z, draw: () => ren.tagged('trigon', () => ren.casting(B, PROPS.trigon.x, PROPS.trigon.z, () => drawTrigon(ren, B, PROPS.trigon))) },
    { z: PROPS.pack.z, draw: () => ren.tagged('pack', () => drawPack(ren, B, PROPS.pack)) },
    ...seatLogStatic(ren, B),
    { z: -13, draw: () => drawHearthstones(ren, B) },
    { z: 0, draw: () => ren.tagged('fire', () => drawStoneRing(ren, B)) },
  ]
  for (const s of statics.sort((a, b) => a.z - b.z)) s.draw()
  // small things without normals of their own
  ren.region = 0
  for (const t of TUFTS) if (!EDGE_TUFTS.includes(t)) drawTuft(ren, B, t)
  for (const rd of REEDS) if (!EDGE_REEDS.includes(rd)) drawReed(ren, B, rd)
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
  findPoolZone(ren)
}

/** The dry ground's colour (fillPool() puts the water and its shore over it). */
function groundCol(x: number, z: number): Color {
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
function foliage(ren: Renderer, B: Buf, lobes: Lobe[], f: Foliage) {
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
  ren.region++
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
      ren.put(
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
function drawTree(ren: Renderer, B: Buf, t: Tree) {
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
  ren.region++
  for (let py = by; py >= trunkTop; py--) {
    for (let k = 0; k < tw; k++) {
      const u = tw > 1 ? ((k + 0.5) / tw) * 2 - 1 : 0
      const px = bx - (tw >> 1) + k
      ren.put(
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
        ren.put(
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
    ren.put(B, bx - (tw >> 1) - 1, by, C.trunk, t.x, t.z, 0, by, t.z, false, shape.cylinder(-0.9))
    ren.put(B, bx + tw - (tw >> 1), by, C.trunk, t.x, t.z, 0, by, t.z, false, shape.cylinder(0.9))
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
        ren.put(B, px, py + j, C.trunk, t.x, t.z, (by - py) / ys, by, t.z, false, shape.flat, texAt('tree', 'trunk', px, py + j, t.seed), bark)
    }
  }
  foliage(ren, B, crown, {
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
function drawDetail(ren: Renderer, B: Buf, d: Detail) {
  const [bx, by, s] = project(d.x, 0, d.z)
  const rng = rngFrom(d.seed)
  const dep = d.z
  const plant = (px: number, py: number, c: Color, nrm: Normal = [0, 0.35, 0.94]) =>
    ren.put(B, px, py, c, d.x + (px - bx) / s, d.z, (by - py) / s, by, dep, false, nrm)
  ren.region++
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
          ren.put(
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
          ren.put(
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
          ren.put(
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
          ren.put(B, px, py, c, d.x + (px - bx) / s, d.z, ht / s, by, dep + 0.01, false, [0, 0.9, 0.44])
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
          ren.put(
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
        for (let j = 0; j < h; j++) ren.put(B, mx, my - j, C.mushPale, d.x, d.z + oz, j / s, my, d.z + oz, false, shape.cylinder(0))
        for (let k = -w; k <= w; k++) {
          ren.put(B, mx + k, my - h, glow ? C.mushPale : C.mushTan, d.x, d.z + oz, h / s, my, d.z + oz, false, shape.dome(k / (w + 1), -0.3))
          if (Math.abs(k) < w)
            ren.put(B, mx + k, my - h - 1, glow ? C.mushPale : C.mushTan, d.x, d.z + oz, (h + 1) / s, my, d.z + oz, false, shape.dome(k / (w + 1), -0.8))
          if (glow) ren.detailGlows.push({ x: mx + k, y: my - h - (Math.abs(k) < w ? 1 : 0), dep: d.z + oz + 0.01, ph: rng() * 6, tag: ren.tag })
        }
      }
      break
    }
  }
}

/** A bush: a mound of overlapping lobes sitting on the ground, dotted along their rims. */
function drawBush(ren: Renderer, B: Buf, b: Bush) {
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
  foliage(ren, B, lobes, {
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
function drawHut(ren: Renderer, B: Buf, hut: Point) {
  ren.drawArtNow(B, HUT, hut.x, hut.z, {})
}

/** The knight's own sword, planted point-down beside him. */
export function drawSword(ren: Renderer, B: Buf, p: Point) {
  ren.drawArt(B, SWORD, p.x, p.z)
}

function drawPack(ren: Renderer, B: Buf, p: Point) {
  ren.drawArt(B, PACK, p.x, p.z)
}

export function drawGrave(ren: Renderer, B: Buf, g: Point & { helm?: boolean }, i: number) {
  const [bx, by] = project(g.x, 0, g.z)
  const dep = g.z
  ren.region++
  disc(
    (px, py, u, v) =>
      ren.put(
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
  const put = (x: number, r: number, c: Color, n: Normal, mh = 0, mw = 0) => ren.put(B, bx + x, by - r, c, g.x, g.z, r / RES, by, dep + 0.1, false, n, mh, mw)
  ren.region++
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
    ren.region++
    disc(
      (px, py, u, v) => ren.put(B, px, py, v < 0 && u < 0 ? C.stoneHi : C.helm, g.x, g.z, 14 - v, by, dep + 0.2, false, shape.dome(u, v), 0, WEIGHT.metal),
      bx + tk,
      by - 30,
      2 * RES,
      2 * RES,
    )
    for (let k = 1; k <= 3; k++) ren.put(B, bx + tk + k, by - 30, C.door, g.x, g.z, 15, by, dep + 0.3, false, shape.flat) // visor slit
    ren.put(B, bx + tk + 2, by - 28, C.door, g.x, g.z, 14, by, dep + 0.3, false, shape.flat)
  }
}

function drawLanternPost(ren: Renderer, B: Buf, p: Point) {
  ren.drawArt(B, lanternCut().post, p.x, p.z) // the lantern itself is drawn with the moving things (it can be carried off)
}

/**
 * The trigon stone: a bevelled slab of grainy, pitted, rain-streaked stone with a triangle
 * cut into it. The cut is a groove (low micro height) so its lips catch the rune's light.
 */
function drawTrigon(ren: Renderer, B: Buf, p: Point) {
  const [bx, by, s] = project(p.x, 0, p.z)
  const hgt = Math.round(40 * s)
  const wid = Math.round(7 * s)
  const hy = by - Math.round(hgt * 0.6)
  const carved = new Set(trigonPx.map(([dx, dy]) => `${dx},${dy}`))
  const inside = new Set(TRIGON_INSIDE.map(([dx, dy]) => `${dx},${dy}`))
  ren.region++
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
      ren.put(B, px, py, c, p.x + k / s, p.z, r / s, by, p.z, false, shape.slab(k, wid, r, hgt), mh, surf('trigon', 'stone').relief)
    }
  }
}

/** A ring of stones around the fire: grainy domes. */
function drawStoneRing(ren: Renderer, B: Buf) {
  for (const st of STONE_RING)
    ren.casting(B, st.x, st.z, () => {
      const [sx, sy, s] = project(st.x, 0, st.z)
      ren.region++
      disc(
        (px, py, u, v) => {
          let c = hash(px * 3 + st.seed, py) < 0.3 ? C.stoneD : C.stone
          if (v < -0.2 && u < 0.2) c = C.stoneHi
          if (v > 0.5) c = C.stoneD
          ren.put(
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
function drawHearthstones(ren: Renderer, B: Buf) {
  HEARTHSTONES.forEach((hs, idx) => ren.casting(B, hs.x, hs.z, () => drawHearthstone(ren, B, hs, idx)))
}

function drawHearthstone(ren: Renderer, B: Buf, hs: (typeof HEARTHSTONES)[number], idx: number) {
  {
    const prevTag = ren.tag
    ren.tag = tagId(`hearth${idx}`)
    const [bx, by, s] = project(hs.x, 0, hs.z)
    const hgt = Math.round(hs.h * s * 0.75)
    const cy = by - Math.round(hgt * 0.55)
    const carving = new Set(CROWN_PX.map(([dx, dy]) => `${dx},${dy}`))
    ren.region++
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
        ren.put(B, px, py, c, hs.x + k / s, hs.z, r / s, by, hs.z, false, shape.slab(k, half, r, hgt), mh, surf('hearthstone', 'stone').relief)
      }
    }
    ren.tag = prevTag
  }
}

/** A tuft of grass, now and then with a flower (no normals of its own). */
function drawTuft(ren: Renderer, B: Buf, t: (typeof TUFTS)[number]) {
  const [sx, sy] = project(t.x, 0, t.z)
  for (let k = 0; k < t.n; k++) {
    const hgt = 1 + (((t.s * 7 + k) % 3) | 0)
    for (let j = 0; j < hgt * RES; j++) ren.put(B, sx + (k * 2 - t.n) * RES, sy - j, C.tuft, t.x, t.z, j / RES, sy, t.z)
  }
  if (t.flower) {
    for (let j = 0; j < 5; j++) ren.put(B, sx, sy - j, C.tuft, t.x, t.z, j / RES, sy, t.z)
    for (const [dx, dy] of [
      [0, -7],
      [-1, -6],
      [1, -6],
      [0, -5],
    ])
      ren.put(B, sx + dx, sy + dy, C.flower, t.x, t.z, 3, sy, t.z)
  }
}

/** A reed at the pool's edge, some with a cattail. */
function drawReed(ren: Renderer, B: Buf, rd: (typeof REEDS)[number]) {
  const [sx, sy] = project(rd.x, 0, rd.z)
  for (let j = 0; j < rd.h * RES; j++) ren.put(B, sx, sy - j, j >= (rd.h - 1) * RES ? C.reedHi : C.reed, rd.x, rd.z, j / RES, sy, rd.z)
  if (rd.s < 0.4) {
    for (let j = 1; j <= 5; j++) for (let k = 0; k < 2; k++) ren.put(B, sx + k, sy - rd.h * RES + j, C.cattail, rd.x, rd.z, rd.h, sy, rd.z)
  }
}

/** A lily pad lies flat on the water: it blocks reflections and casts none. */
function drawPad(ren: Renderer, B: Buf, x: number, z: number) {
  const [sx, sy] = project(x, 0, z)
  disc(
    (px, py, u, v) => {
      if (u > 0.25 && Math.abs(v) < 0.5) return // the notch
      ren.put(B, px, py, v > 0.5 || u > 0.8 ? C.frogD : C.pad, x, z, 0.2, sy, z - 0.3, true)
    },
    sx,
    sy - 1,
    5,
    2,
  )
}

/** The pool's edge at its current level: pads on the water, the tufts and reeds it hasn't swallowed. */
export function drawPoolEdge(ren: Renderer, B: Buf, lvl: number) {
  for (const [x, z] of PADS) if (inPool(x, z, lvl)) drawPad(ren, B, x, z)
  for (const t of EDGE_TUFTS) if (!inPool(t.x, t.z, lvl * 1.2)) drawTuft(ren, B, t)
  for (const rd of EDGE_REEDS) if (!inPool(rd.x, rd.z, lvl * 0.98)) drawReed(ren, B, rd)
}

/**
 * Fill the pool to `lvl`: which ground pixels are under water, which are its wet shore, and
 * which are dry. Only the pool's region is touched, so the rain can raise it every frame.
 */
export function fillPool(ren: Renderer, lvl: number) {
  const B = ren.st
  ren.stillChanged = ren.uploadAll = true
  const Z = ren.poolZone
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
  ren.poolLevel = lvl
}

/** Remember the ground the pool can reach (after the static layer is drawn). */
function findPoolZone(ren: Renderer) {
  const B = ren.st
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
    // something stands over ren pixel (its colour isn't the ground's): leave its colour alone
    Z.covered[k] = B.dep[i] === GROUND_DEPTH ? 0 : 1
    const [gx, gz] = unproject(i % W, (i / W) | 0)!
    const c = groundCol(gx, gz)
    Z.dry.set(c, k * 3)
  })
  ren.poolZone = Z
}

/** The knight's log, once it exists and has a place: drawn with the still scene, behind him. */
function seatLogStatic(ren: Renderer, B: Buf): { z: number; draw: () => void }[] {
  const art = seatLog()
  const p = PROPS.seatLog
  if (!art || !p) return []
  return [{ z: p.z, draw: () => ren.tagged('seatlog', () => ren.drawArt(B, art, p.x, p.z)) }]
}
