/** From the drawn frame to the screen: lighting it (on the CPU, or the GPU with the same model), the bloom, and what is drawn over the top (rain, the warm wash, labels). */
import { settings, type View } from '../engine/settings'
import { isRaining, lightRadius, rainAmount, type World } from '../sim'
import { clamp, hash, vnoise, type Color } from '../util'
import { C, H, N, RES, W, mistAt, project } from '../world'
import { BANDS, BAND_BITS, TILES, TILES_X, TILE_BITS } from './frame'
import { GpuCompositor, type GpuFrame } from './gpu'
import { cullLights, gatherLight, groundGrain, type Prepared } from './lights'
import { CLOUD, CLOUD_RIM, FLASH, MOON_DISC, MOON_KEY, STARS, VIEW, cloudAt, inMoon } from './look'
import { drawDebug, drawHover, drawOverlays } from './overlays'
import type { Renderer } from './renderer'
import { OBJECT_DARKNESS, shadowAt, shadowOnObject } from './shadows'
import { moonLit, sampleMoon } from './sky'

/** The CPU lighting pass (the reference; the GPU compositor ports this). */
export function compose(ren: Renderer, w: World, view: View = settings.view) {
  const t = w.t
  const B = ren.fb
  const fx = ren.fx
  const out = ren.out
  const W8 = w.weather
  const amb = 1 - 0.2 * W8.rain - 0.08 * W8.cloud
  const flash = W8.flash
  const L = settings.layers
  const useNormals = L.normals
  const moonK = settings.ambient.moon
  const M = ren.moon
  const MS = ren.moonShadow
  const ms = new Float32Array(8) // a sampled moon pixel
  const lights = ren.prepared
  const nrm: [number, number, number] = [0, 0, 0]
  // Light culling: most lights (caps, candles, fireflies) only reach a small patch, so each
  // 32x32 tile of the screen gathers only the lights that can reach what it shows.
  const boxes = ren.tileBoxes
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
        if (B.sky[i] && sampleMoon(ren, x, y, ms)) {
          // the moon, lit by its own sun, over the sky behind it (and under the clouds)
          const k = moonLit(ren, ms)
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
  if (view !== 'final') showBuffer(ren, view, tileLights)
  else if (L.stars)
    for (const s of STARS) {
      const i = s.y * W + s.x
      if (B.a[i] || !B.sky[i] || inMoon(s.x, s.y)) continue // behind everything: only where the sky itself shows, never on the moon
      const a = s.b * (0.55 + 0.45 * Math.sin(t * 1.3 + s.ph)) * (1 - cloudAt(s.x, s.y, t, w.weather.cloud)) * (1 + 1.3 * ren.hush) // they swell in the hush
      out.r[i] += 0.86 * a
      out.g[i] += 0.88 * a
      out.b[i] += 0.94 * a
    }
}

export function gpuCompositor(ren: Renderer): GpuCompositor | null {
  if (ren.gpu === undefined) ren.gpu = GpuCompositor.create(W, H)
  return ren.gpu
}

/** Everything the GPU compositor needs for this frame (the buffers themselves, no copies). */
export function gpuFrame(ren: Renderer, w: World): GpuFrame {
  if (!ren.gpuChannels) {
    const B = ren.fb
    const fx = ren.fx
    const starB = new Float32Array(N)
    const starPh = new Float32Array(N)
    for (const s of STARS) {
      starB[s.y * W + s.x] += s.b
      starPh[s.y * W + s.x] = s.ph
    }
    ren.gpuChannels = {
      ...Object.fromEntries(Object.entries(B)),
      ...Object.fromEntries(Object.entries(fx).map(([k, v]) => [`fx.${k}`, v])),
      starB,
      starPh,
    } as GpuFrame['channels']
  }
  const L = settings.layers
  return {
    channels: ren.gpuChannels,
    staticVersion: ren.shadows.version,
    frame: ren.frameNo,
    bands: bandsToUpload(ren),
    moonDisc: MOON_DISC.up ? [MOON_DISC.x, MOON_DISC.y, MOON_DISC.r] : [0, 0, 0],
    moonFace: ren.moonFace,
    moonSun: ren.moonSun,
    earthshine: ren.earthshine,
    fullRelief: ren.fullRelief,
    starK: 1 + 1.3 * ren.hush,
    lights: ren.prepared,
    t: w.t,
    amb: 1 - 0.2 * w.weather.rain - 0.08 * w.weather.cloud,
    cloud: w.weather.cloud,
    flash: w.weather.flash,
    moonK: settings.ambient.moon,
    moon: ren.moon,
    moonShadow: ren.moonShadow,
    mistK: settings.ambient.mist,
    mistColor: C.mist,
    layers: { normals: L.normals, reflections: L.reflections, emissives: L.emissives, mist: L.mist, glints: L.glints, stars: L.stars, bloom: L.bloom },
    raining: isRaining(w),
    heat: w.fire.heat,
    bloomK: settings.ambient.bloom,
    width: W,
    height: H,
    res: RES,
    outW: W * ren.scale,
    outH: H * ren.scale,
  }
}

/**
 * The bands of rows that changed since last frame (touched now, or put back from last frame),
 * or null when everything did (the still layer changed).
 */
function bandsToUpload(ren: Renderer): { bits: number; mask: Uint8Array } | null {
  if (ren.uploadAll) {
    ren.uploadAll = false
    return null
  }
  const mask = new Uint8Array(BANDS)
  for (let b = 0; b < BANDS; b++) mask[b] = ren.touched[b] | ren.touchedBefore[b]
  return { bits: BAND_BITS, mask }
}

/** The CPU vs GPU view: the CPU frame dimmed, with every pixel where the GPU disagrees in red (x8). */
export function showDiff(ren: Renderer, lit: Float32Array) {
  const out = ren.out
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
  ren.gpuDiff = { mean: sum / N, max, over: over / N }
}

/** Replace the frame with one of the buffers behind it (the editor's views). */
function showBuffer(ren: Renderer, view: View, tileLights: Prepared[][]) {
  const B = ren.fb
  const fx = ren.fx
  const out = ren.out
  const ms = new Float32Array(8)
  for (let i = 0; i < N; i++) {
    let r = 0
    let g = 0
    let b = 0
    const obj = B.a[i] && B.obj[i]
    // the moon, where it shows (open sky)
    const moon = !B.a[i] && B.sky[i] && (view === 'albedo' || view === 'normals') && sampleMoon(ren, i % W, (i / W) | 0, ms)
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
          for (const l of ren.prepared) if (l.shadow) occ = Math.max(occ, shadowAt(l.shadow, B.kx[i], B.kz[i]))
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

export function present(ren: Renderer, w: World, gpuCanvas: HTMLCanvasElement | null = null) {
  const { ctx, scale: S, fx, out } = ren
  const DW = W * S
  const DH = H * S
  if (gpuCanvas) {
    // the GPU drew the lit frame and its bloom at the output size
    ctx.drawImage(gpuCanvas, 0, 0)
    if (settings.layers.bloom && settings.layers.emissives) drawWarmWash(ren, w)
    drawOver(ren, w)
    return
  }
  const d = ren.outImg.data
  const e = ren.fxImg.data
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
  ren.outX.putImageData(ren.outImg, 0, 0)
  ren.fxX.putImageData(ren.fxImg, 0, 0)

  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(ren.outC, 0, 0, DW, DH)
  if (settings.layers.bloom && settings.layers.emissives && settings.view === 'final') {
    // soft bloom from the emissive layer, plus a faint warm wash around the fire
    const heat = Math.min(1.2, w.fire.heat)
    ctx.globalCompositeOperation = 'lighter'
    ctx.imageSmoothingEnabled = true
    ctx.filter = `blur(${3 * S * RES}px)`
    ctx.globalAlpha = Math.min(1, 0.85 * (0.45 + 0.55 * heat) * settings.ambient.bloom)
    ctx.drawImage(ren.fxC, 0, 0, DW, DH)
    ctx.filter = `blur(${9 * S * RES}px)`
    ctx.globalAlpha = Math.min(1, 0.55 * (0.3 + 0.7 * heat) * settings.ambient.bloom)
    ctx.drawImage(ren.fxC, 0, 0, DW, DH)
    ctx.filter = 'none'
    ctx.globalAlpha = 1
  }
  ctx.restore()
  if (settings.layers.bloom && settings.layers.emissives && settings.view === 'final') drawWarmWash(ren, w)
  drawOver(ren, w)
}

/** A faint warm wash around the fire (with the bloom). */
function drawWarmWash(ren: Renderer, w: World) {
  const { ctx, scale: S } = ren
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
function drawOver(ren: Renderer, w: World) {
  if (rainAmount(w) > 0 && settings.layers.rain) drawRain(ren, w)
  if (settings.layers.labels) drawHover(ren)
  else ren.hovered = null
  if (settings.overlays.states) drawDebug(ren, w)
  drawOverlays(ren, w)
}

/** Rain as straight, thin streaks at full output resolution, over the pixel art. */
function drawRain(ren: Renderer, w: World) {
  const { ctx, scale: S } = ren
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
