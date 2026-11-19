/** What is drawn over the lit frame for the visitor and the editor: the hovered thing's name, the debug states, the light and shadow overlays, and inspecting a pixel. */
import { settings } from '../engine/settings'
import { hutOccupancy, type World } from '../sim'
import { walkable } from '../sim/nav'
import { type Color } from '../util'
import { H, HORIZON, PROPS, RES, W, project } from '../world'
import { FONT, LABEL_MIN, TAGS, TAG_KEYS, tagId, wrapText } from './labels'
import { gatherLight, groundGrain } from './lights'
import type { PixelInfo, Renderer } from './renderer'

/** The hover tag key of the thing at this pixel ('hut0', 'tree12', ...), or null. */
export function tagAt(ren: Renderer, x: number, y: number): string | null {
  if (x < 0 || x >= W || y < 0 || y >= H) return null
  const id = ren.fb.hv[y * W + x]
  if (!id) return null
  for (const [k, v] of TAGS) if (v === id) return k
  return null
}

/** Everything about one pixel of the last frame, and how much each light gives it. */
export function inspectPixel(ren: Renderer, x: number, y: number): PixelInfo | null {
  if (x < 0 || x >= W || y < 0 || y >= H) return null
  const B = ren.fb
  const fx = ren.fx
  const i = y * W + x
  const what = !B.a[i] ? 'sky' : B.obj[i] ? 'object' : 'ground'
  const tag = B.hv[i]
  const ground = what === 'ground'
  const normal: [number, number, number] | null = what === 'object' && B.nz[i] > 0 ? [B.nx[i], B.ny[i], B.nz[i]] : null
  const lights =
    what === 'sky'
      ? []
      : ren.prepared
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
    owner: ren.labels.get(tag)?.[0] ?? null,
    depth: B.dep[i],
    world: [B.kx[i], B.ky[i], B.kz[i]],
    normal,
    albedo: B.a[i] ? [B.r[i], B.g[i], B.b[i]] : [B.bgr[i], B.bgg[i], B.bgb[i]],
    material: { micro: B.mh[i], weight: B.mw[i], spec: B.sp[i], glint: B.gl[i] },
    emissive: fx.a[i] > 0 ? { a: fx.a[i], color: [fx.r[i], fx.g[i], fx.b[i]], depth: fx.dep[i], bloom: fx.bw[i] } : null,
    pool: !!B.pool[i],
    out: [ren.out.r[i], ren.out.g[i], ren.out.b[i]],
    lights,
  }
}

/** The editor's overlays, drawn over the finished frame at output resolution. */
export function drawOverlays(ren: Renderer, w: World) {
  const O = settings.overlays
  const sel = settings.selectedLight
  const insp = settings.inspect
  const pick = settings.selection
  if (!O.lights && !O.casters && !O.nav && !O.paths && !sel && !insp && !pick) return
  const { ctx, scale: S } = ren
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
    for (const sil of [...ren.shadows.statics, ...ren.shadows.dynamics]) {
      const [bx, by] = project(sil.x, 0, sil.z)
      ctx.fillStyle = 'rgba(255,200,80,0.35)'
      for (let k = 0; k < sil.runs.length; k += 3) ctx.fillRect((bx + sil.runs[k]) * S, (by - sil.runs[k + 2]) * S, S, (sil.runs[k + 2] - sil.runs[k + 1]) * S)
      ellipse(sil.x, sil.z, 0.6, 'rgba(255,120,60,0.9)')
    }
  }
  if (O.lights || sel) {
    for (const l of ren.lastLights) {
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

/**
 * Name whatever is under the pointer. Every drawn pixel knows what it belongs to, so this is
 * exact: the glowcap behind the grave answers for its own pixels. A pixel or two of slack
 * makes small things easy to catch.
 */
/** What's under the pointer (in the last frame drawn): sets `hovered` and `hoverKey`, and returns its tag. */
export function pick(ren: Renderer): number {
  const p = ren.pointer
  ren.hovered = null
  ren.hoverKey = null
  if (!p) return 0
  const B = ren.fb
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
        if (t && ren.labels.has(t) && notHeld(ren, t)) id = t
      }
    }
  }
  const inside = px >= 0 && px < W && py >= 0 && py < H
  if (!id && inside && B.pool[py * W + px] && !B.obj[py * W + px]) id = tagId('pool')
  const label = ren.labels.get(id)
  if (!label) return 0
  ren.hovered = [label[0], label[1]]
  ren.hoverKey = TAG_KEYS.get(id) ?? null
  return id
}

function notHeld(ren: Renderer, id: number) {
  return !ren.heldKey || TAG_KEYS.get(id) !== ren.heldKey
}

export function drawHover(ren: Renderer) {
  const id = pick(ren)
  const label = ren.labels.get(id)
  if (!id || !label) return
  const B = ren.fb
  const px = Math.floor(ren.pointer!.x)
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
  const { ctx, scale: S } = ren
  // output pixels per base pixel: text keeps its size at any resolution, but never so small on
  // screen that it can't be read (a phone, or a small frame): its name at least LABEL_MIN CSS px
  const perCss = ren.cssWidth ? (W * S) / ren.cssWidth : 1
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

export function drawDebug(ren: Renderer, w: World) {
  const { ctx, scale: S } = ren
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
