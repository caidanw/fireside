/**
 * The art editor: every creature frame, prop and relic, editable pixel by pixel, with its
 * palette, parts (the shapes its normals are built from) and shine. A flat canvas to paint
 * on, and previews: shaded under a light you can move, normals, and parts. Edits are live
 * (the scene shows them on the next frame) and staged as you go (see staging.ts).
 */
import { DATA, changed, resolvePalette, type DataFile, type HexPalette, type PartData } from '../art'
import { TEXTURES } from '../materials'
import { forgetNormals, partNormals, type Part } from '../normals'
import { GLOW_TINT } from '../renderer'
import { hex } from '../util'

type Child = Node | string | null | undefined | false
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'class') el.className = String(v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids) if (c) el.append(c)
  return el
}

/** One editable piece of art: where its rows, palettes, parts and shine live in the data. */
interface Target {
  id: string
  group: string
  label: string
  file: DataFile
  rows: () => string[]
  palettes: () => Record<string, HexPalette>
  parts: () => PartData[] | null
  shine: () => Record<string, number> | null
  /** Which chars glow at night, and how strongly. */
  glow: () => Record<string, number>
  /** Chars set back behind the front (a doorway seen into), if this art has any. */
  depth?: () => Record<string, number> | undefined
  /** A prop's anchor: the column it stands on, and how many rows reach below the ground (its foot). */
  anchor?: { get: () => number; set: (v: number) => void; foot: () => number; setFoot: (v: number) => void }
}

function targets(): Target[] {
  const out: Target[] = []
  for (const [name, s] of Object.entries(DATA.sprites))
    for (const frame of Object.keys(s.frames))
      out.push({
        id: `sprite:${name}:${frame}`,
        group: name,
        label: frame,
        file: 'sprites',
        rows: () => DATA.sprites[name].frames[frame],
        palettes: () => DATA.sprites[name].palettes,
        parts: () => DATA.sprites[name].parts,
        shine: () => DATA.sprites[name].shine,
        glow: () => (DATA.sprites[name].glow ??= {}),
      })
  for (const name of Object.keys(DATA.props)) {
    if (name === 'relics') continue
    const p = () => DATA.props[name]
    out.push({
      id: `prop:${name}`,
      group: 'props',
      label: name,
      file: 'props',
      rows: () => p().rows,
      palettes: () => ({ default: p().palette }),
      parts: () => p().parts,
      shine: () => p().shine,
      glow: () => (p().glow ??= {}),
      depth: () => p().depth,
      anchor: {
        get: () => p().anchor,
        set: (v) => (p().anchor = v),
        foot: () => p().foot ?? 0,
        setFoot: (v) => {
          if (v > 0) p().foot = v
          else delete p().foot
        },
      },
    })
  }
  for (const name of Object.keys(DATA.props.relics)) {
    const r = () => DATA.props.relics[name]
    out.push({
      id: `relic:${name}`,
      group: 'relics',
      label: name,
      file: 'props',
      rows: () => r().rows,
      palettes: () => ({ default: r().palette }),
      parts: () => (r().parts ??= []),
      shine: () => (r().shine ??= {}),
      glow: () => (r().glow ??= {}),
    })
  }
  return out
}

const KINDS = ['dome', 'cylinder', 'lathe', 'tube', 'cap', 'under', 'flat']
const PART_TINTS = ['#e0674a', '#4aa3e0', '#e0c04a', '#5fd08a', '#b36ae0', '#e07fb8', '#7fe0d6', '#a0a0ff', '#ffb070', '#9fd060', '#d0d0d0']
type Tool = 'pencil' | 'erase' | 'pick' | 'fill' | 'anchor'
/** Painting colours (chars), or painting pixels into parts. */
type Mode = 'colours' | 'parts'
/** Letters for new twin chars (the parts brush makes them). Never '.', '$' or '='. */
const SPARE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+:;<>?@^_~!|'
/** A palette entry's root char: a twin ("=x") is x; anything else is itself. */
const rootOf = (pal: HexPalette, ch: string) => (pal[ch]?.startsWith('=') ? pal[ch].slice(1) : ch)
/** An undo step: the rows, and the palettes, parts, shine, glow and depth (the parts brush changes those). */
interface Snap {
  rows: string[]
  meta: string
}

export interface ArtEditor {
  /** The workspace (goes in the middle). */
  center: HTMLElement
  /** The asset list (goes on the left). */
  left: HTMLElement
  /** Palette and parts (go on the right). */
  right: HTMLElement
  /** Where the live scene sits while editing art. */
  pip: HTMLElement
  /** Redraw (after something outside changed the data, e.g. discarding staged edits). */
  refresh(): void
}

export function createArtEditor(edited: (file: DataFile) => void): ArtEditor {
  const all = targets()
  let target = all[0]
  let paletteName = 'default'
  /** The variant last picked by hand (gold, crimson...), returned to after a frame-group palette like elder. */
  let variant = 'default'
  let brush = ''
  let mode: Mode = 'colours'
  /** The part the parts brush paints into. */
  let partBrush = 0
  let tool: Tool = 'pencil'
  let zoom = 12
  let grid = true
  const light = { x: 0.55, y: 0.35 }
  const undo = new Map<string, Snap[]>()
  const redo = new Map<string, Snap[]>()

  // ---------------------------------------------------------------- the live data
  const rows = () => target.rows()
  const width = () => Math.max(1, ...rows().map((r) => r.length))
  const palette = (): HexPalette => target.palettes()[paletteName] ?? Object.values(target.palettes())[0]
  const colorOf = (ch: string): string | null => {
    let v = palette()[ch]
    if (v?.startsWith('=')) v = palette()[v.slice(1)] // a twin: its root's colour
    if (!v) return null
    if (v.startsWith('$')) return (DATA.palette as Record<string, string>)[v.slice(1)] ?? '#ff00ff'
    return v.startsWith('=') ? '#ff00ff' : v
  }
  /**
   * The palette the scene draws this art with: one named after the frame (elderWalk0 → elder);
   * otherwise not one of those frame-group palettes, but the current one if it has every colour
   * the frame uses, else the first that does.
   */
  const choosePalette = () => {
    const pals = Object.keys(target.palettes())
    const frames = all.filter((t) => t.group === target.group).map((t) => t.label.toLowerCase())
    const grouped = pals.filter((k) => k !== 'default' && frames.some((f) => f.startsWith(k.toLowerCase())))
    const named = grouped.find((k) => target.label.toLowerCase().startsWith(k.toLowerCase()))
    if (named) return (paletteName = named)
    const used = [...new Set(rows().join('').replace(/\./g, ''))]
    const fits = (k: string) => pals.includes(k) && !grouped.includes(k) && used.every((ch) => ch in target.palettes()[k])
    paletteName = [variant, paletteName, ...pals].find(fits) ?? pals.find((k) => !grouped.includes(k)) ?? pals[0]
  }
  /** Live while painting (the scene follows), staged when the stroke ends. */
  let liveTimer = 0
  /** The current palette resolved to colours (for the textured normals), kept until an edit. */
  let resolvedPal: { key: string; pal: ReturnType<typeof resolvePalette> } | null = null
  const resolved = () => {
    const key = `${target.id}:${paletteName}`
    if (resolvedPal?.key !== key) resolvedPal = { key, pal: resolvePalette(palette()) }
    return resolvedPal.pal
  }
  const touch = (final: boolean) => {
    resolvedPal = null
    forgetNormals()
    if (final) {
      window.clearTimeout(liveTimer)
      edited(target.file)
    } else if (!liveTimer)
      liveTimer = window.setTimeout(() => {
        liveTimer = 0
        changed(target.file)
      }, 120)
    draw()
  }
  const snap = (): Snap => ({
    rows: [...rows()],
    meta: JSON.stringify({ palettes: target.palettes(), parts: target.parts(), shine: target.shine(), glow: target.glow(), depth: target.depth?.() ?? null }),
  })
  const remember = () => {
    const stack = undo.get(target.id) ?? []
    stack.push(snap())
    if (stack.length > 100) stack.shift()
    undo.set(target.id, stack)
    redo.delete(target.id)
  }
  const restore = (from: Map<string, Snap[]>, to: Map<string, Snap[]>) => {
    const s = from.get(target.id)?.pop()
    if (!s) return
    to.set(target.id, [...(to.get(target.id) ?? []), snap()])
    const r = rows()
    r.splice(0, r.length, ...s.rows)
    // everything else in place, so the scene's live views keep pointing at it
    const m = JSON.parse(s.meta)
    const fill = (into: Record<string, unknown> | null | undefined, src: Record<string, unknown> | null) => {
      if (!into || !src) return
      for (const k of Object.keys(into)) delete into[k]
      Object.assign(into, src)
    }
    for (const [k, p] of Object.entries(target.palettes())) fill(p, m.palettes[k])
    const parts = target.parts()
    if (parts && m.parts) parts.splice(0, parts.length, ...m.parts)
    fill(target.shine(), m.shine)
    fill(target.glow(), m.glow)
    fill(target.depth?.(), m.depth)
    touch(true)
  }

  // ---------------------------------------------------------------- the parts brush
  /** Every frame drawn with this art's palettes (a sprite's frames share them). */
  const siblings = () => all.filter((t) => Object.values(t.palettes())[0] === Object.values(target.palettes())[0])
  /** Which part a char is in (the first that lists it), or -1. */
  const partOf = (ch: string) => (target.parts() ?? []).findIndex((p) => p.chars.includes(ch))
  /** Do two chars look and behave the same: the same colour in every palette, the same shine, glow and depth? */
  const alike = (a: string, b: string) => {
    for (const pal of Object.values(target.palettes())) {
      if (!(a in pal) && !(b in pal)) continue
      if (rootOf(pal, a) !== rootOf(pal, b) && pal[a] !== pal[b]) return false
    }
    const same = (m: Record<string, number> | null | undefined) => (m?.[a] ?? 0) === (m?.[b] ?? 0)
    return same(target.shine()) && same(target.glow()) && same(target.depth?.())
  }
  /**
   * The char to paint over `ch` to put that pixel in part `p`: one already there that looks the
   * same, or a new twin ("=root" in every palette, the same shine, glow and depth).
   */
  const twinIn = (ch: string, p: number): string => {
    const parts = target.parts()!
    const there = [...new Set([...parts[p].chars])].find((c) => partOf(c) === p && alike(c, ch))
    if (there) return there
    const taken = new Set(siblings().flatMap((t) => [...t.rows().join('')]))
    for (const pal of Object.values(target.palettes())) for (const k of Object.keys(pal)) taken.add(k)
    const twin = [...SPARE].find((c) => !taken.has(c))
    if (!twin) return ch
    for (const pal of Object.values(target.palettes())) if (ch in pal) pal[twin] = `=${rootOf(pal, ch)}`
    for (const m of [target.shine(), target.glow(), target.depth?.()]) if (m && m[ch] !== undefined) m[twin] = m[ch]
    parts[p].chars += twin
    return twin
  }
  /** Put one pixel in part `p`. */
  const paintPart = (r: number, c: number, p: number) => {
    const ch = rows()[r]?.[c]
    if (!ch || ch === '.' || partOf(ch) === p) return
    setPixel(r, c, twinIn(ch, p))
  }
  /** Put a connected patch of one part (or of loose pixels) in part `p`. */
  const fillPart = (r0: number, c0: number, p: number) => {
    const R = rows()
    const start = R[r0]?.[c0]
    if (!start || start === '.') return
    const from = partOf(start)
    if (from === p) return
    const seen = new Set<number>()
    const stack: [number, number][] = [[r0, c0]]
    while (stack.length) {
      const [r, c] = stack.pop()!
      const ch = R[r]?.[c]
      if (!ch || ch === '.' || seen.has(r * 4096 + c) || partOf(ch) !== from) continue
      seen.add(r * 4096 + c)
      paintPart(r, c, p)
      stack.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1])
    }
  }
  /** Drop twins nothing draws with any more (after a stroke, so the palette doesn't fill up). */
  const tidyTwins = () => {
    const used = new Set(siblings().flatMap((t) => [...t.rows().join('')]))
    const pals = Object.values(target.palettes())
    const twins = new Set(pals.flatMap((pal) => Object.keys(pal).filter((k) => pal[k].startsWith('='))))
    for (const t of twins) {
      if (used.has(t) || pals.some((pal) => t in pal && !pal[t].startsWith('='))) continue
      for (const pal of pals) delete pal[t]
      for (const m of [target.shine(), target.glow(), target.depth?.()]) if (m) delete m[t]
      for (const p of target.parts() ?? []) p.chars = p.chars.replaceAll(t, '')
    }
  }
  const setPixel = (r: number, c: number, ch: string) => {
    const R = rows()
    if (r < 0 || r >= R.length || c < 0) return
    const row = R[r].padEnd(width(), '.')
    if (row[c] === ch) return
    R[r] = row.slice(0, c) + ch + row.slice(c + 1)
  }
  const flood = (r0: number, c0: number, ch: string) => {
    const R = rows()
    const from = R[r0]?.[c0]
    if (from === undefined || from === ch) return
    const stack: [number, number][] = [[r0, c0]]
    while (stack.length) {
      const [r, c] = stack.pop()!
      if (R[r]?.[c] !== from) continue
      setPixel(r, c, ch)
      stack.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1])
    }
  }
  /** Grow or shrink the art at one edge. Sprites stand on their bottom row; props keep their anchor. */
  const resize = (edge: 'top' | 'bottom' | 'left' | 'right', grow: boolean) => {
    remember()
    const R = rows()
    const w = width()
    if (edge === 'top') grow ? R.unshift('.'.repeat(w)) : R.length > 1 && R.shift()
    if (edge === 'bottom') {
      grow ? R.push('.'.repeat(w)) : R.length > 1 && R.pop()
      // a prop's ground stays where it was: the new (or lost) row is below it
      if (target.anchor) target.anchor.setFoot(Math.max(0, target.anchor.foot() + (grow ? 1 : -1)))
    }
    if (edge === 'left' && (grow || w > 1)) {
      for (let i = 0; i < R.length; i++) R[i] = grow ? '.' + R[i].padEnd(w, '.') : R[i].slice(1)
      if (target.anchor) target.anchor.set(Math.max(0, target.anchor.get() + (grow ? 1 : -1)))
    }
    if (edge === 'right' && (grow || w > 1)) for (let i = 0; i < R.length; i++) R[i] = grow ? R[i].padEnd(w, '.') + '.' : R[i].padEnd(w, '.').slice(0, w - 1)
    touch(true)
  }

  // ---------------------------------------------------------------- the canvas
  const canvas = h('canvas', { class: 'art-canvas' })
  const ctx = canvas.getContext('2d')!
  const previews = { scene: h('canvas', {}), shaded: h('canvas', {}), normals: h('canvas', {}), parts: h('canvas', {}) }
  const status = h('span', { class: 'dim' })

  const cellAt = (e: PointerEvent) => {
    const b = canvas.getBoundingClientRect()
    return { r: Math.floor(((e.clientY - b.top) / b.height) * rows().length), c: Math.floor(((e.clientX - b.left) / b.width) * width()) }
  }
  let painting = false
  let last: { r: number; c: number } | null = null
  const act = (e: PointerEvent, first: boolean) => {
    const { r, c } = cellAt(e)
    const from = first ? null : last
    last = { r, c }
    if (mode === 'parts') {
      if (!target.parts()?.length || e.buttons === 2) return
      if (tool === 'pick') {
        const got = rows()[r]?.[c]
        if (got && got !== '.' && partOf(got) >= 0) ((partBrush = partOf(got)), draw())
        return
      }
      if (first) remember()
      if (tool === 'fill') fillPart(r, c, partBrush)
      else if (from) {
        const n = Math.max(Math.abs(r - from.r), Math.abs(c - from.c), 1)
        for (let i = 1; i <= n; i++) paintPart(Math.round(from.r + ((r - from.r) * i) / n), Math.round(from.c + ((c - from.c) * i) / n), partBrush)
      } else paintPart(r, c, partBrush)
      touch(false)
      return
    }
    const ch = e.buttons === 2 || tool === 'erase' ? '.' : brush || '.'
    if (tool === 'pick') {
      const got = rows()[r]?.[c]
      if (got && got !== '.') setBrush(got)
      return
    }
    if (tool === 'anchor' && target.anchor) {
      // the spot it stands on: this column, and this row is the ground (rows below reach toward us)
      if (first) remember()
      target.anchor.set(Math.max(0, Math.min(width() - 1, c)))
      target.anchor.setFoot(Math.max(0, Math.min(rows().length - 1, rows().length - 1 - r)))
      touch(false)
      return
    }
    if (first) remember()
    if (tool === 'fill') flood(r, c, ch)
    else if (from) {
      // a fast drag skips cells: fill in the line between where it was and where it is
      const n = Math.max(Math.abs(r - from.r), Math.abs(c - from.c), 1)
      for (let i = 1; i <= n; i++) setPixel(Math.round(from.r + ((r - from.r) * i) / n), Math.round(from.c + ((c - from.c) * i) / n), ch)
    } else setPixel(r, c, ch)
    touch(false)
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('pointerdown', (e) => {
    painting = true
    canvas.setPointerCapture(e.pointerId)
    act(e, true)
  })
  canvas.addEventListener('pointermove', (e) => {
    const { r, c } = cellAt(e)
    const ch = rows()[r]?.[c]
    const part = ch && ch !== '.' ? partOf(ch) : -1
    const where = part < 0 ? '' : ` · part ${part + 1} (${target.parts()![part].kind})`
    status.textContent = ch === undefined ? '' : `row ${r} · col ${c} · ${ch === '.' ? 'empty' : `'${ch}'${where}`}`
    if (painting && tool !== 'fill') act(e, false)
  })
  canvas.addEventListener('pointerup', () => {
    if (!painting) return
    painting = false
    if (mode === 'parts') tidyTwins()
    touch(true)
  })

  /** Paint the art flat at `z` pixels per pixel, with a checkerboard behind. */
  function drawFlat(c: HTMLCanvasElement, z: number, shade?: (r: number, col: number, rgb: number[]) => number[] | null) {
    const R = rows()
    const w = width()
    c.width = w * z
    c.height = R.length * z
    const x = c.getContext('2d')!
    for (let r = 0; r < R.length; r++)
      for (let col = 0; col < w; col++) {
        const ch = R[r][col] ?? '.'
        const checker = (r + col) % 2 ? '#1b1d21' : '#16181b'
        let fill = checker
        if (ch !== '.') {
          const hx = colorOf(ch)
          const rgb = hx ? hex(hx) : [1, 0, 1]
          const s = shade ? shade(r, col, rgb) : rgb
          fill = s ? `rgb(${s.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})` : checker
        }
        x.fillStyle = fill
        x.fillRect(col * z, r * z, z, z)
      }
  }

  /**
   * The art as the scene shows it at night: dim, its glowing chars lit with a soft halo, standing
   * on the ground at its anchor (props) or its middle (creatures), marked "stands here".
   */
  function drawScene(c: HTMLCanvasElement, z: number) {
    const R = rows()
    const w = width()
    const glow = target.glow()
    const tint = GLOW_TINT[target.id.split(':')[1]] ?? hex('#ffb347')
    const margin = 3 // cells around the art for the halo and the ground
    c.width = (w + margin * 2) * z
    c.height = (R.length + margin + 2) * z
    const x = c.getContext('2d')!
    const ground = (R.length - (target.anchor?.foot() ?? 0) + margin) * z // a prop's foot rows reach below it
    x.fillStyle = '#07090d'
    x.fillRect(0, 0, c.width, ground)
    x.fillStyle = '#15130f'
    x.fillRect(0, ground, c.width, c.height - ground)
    const at = (col: number) => (col + margin) * z
    for (let r = 0; r < R.length; r++)
      for (let col = 0; col < w; col++) {
        const ch = R[r][col] ?? '.'
        if (ch === '.') continue
        const rgb = hex(colorOf(ch) ?? '#ff00ff')
        const g = glow[ch] ?? 0
        // the rest is dim in the dark; what glows is lit in the colour the scene lights it
        const lit = rgb.map((v, i) => v * 0.4 * (1 - g) + (v * 0.3 + tint[i]) * g)
        x.fillStyle = `rgb(${lit.map((v) => Math.round(Math.min(1, v) * 255)).join(',')})`
        x.fillRect(at(col), (r + margin) * z, z, z)
      }
    // the halo, added on top
    x.globalCompositeOperation = 'lighter'
    for (let r = 0; r < R.length; r++)
      for (let col = 0; col < w; col++) {
        const g = glow[R[r][col] ?? '.'] ?? 0
        if (!g) continue
        const rgb = tint.map((v) => Math.round(v * 255))
        const cx = at(col) + z / 2
        const cy = (r + margin) * z + z / 2
        const halo = x.createRadialGradient(cx, cy, 0, cx, cy, z * 3)
        halo.addColorStop(0, `rgba(${rgb.join(',')},${0.22 * g})`)
        halo.addColorStop(1, 'rgba(0,0,0,0)')
        x.fillStyle = halo
        x.fillRect(cx - z * 3, cy - z * 3, z * 6, z * 6)
      }
    x.globalCompositeOperation = 'source-over'
    // where it stands: a marker under its foot, and a tick up from the ground beside it
    const foot = target.anchor ? target.anchor.get() : w >> 1
    const fx = at(foot) + z / 2
    x.fillStyle = '#f08a3c'
    x.beginPath()
    x.moveTo(fx, ground + 1)
    x.lineTo(fx - z * 1.2, ground + z * 1.8)
    x.lineTo(fx + z * 1.2, ground + z * 1.8)
    x.fill()
    x.fillRect(fx - 1, ground - z * 1.5, 2, z * 1.5)
    x.fillStyle = '#f08a3c66'
    x.fillRect(0, ground, c.width, 1)
  }

  function draw() {
    const R = rows()
    const w = width()
    const room = canvas.parentElement?.getBoundingClientRect()
    zoom = room ? Math.max(2, Math.min(28, Math.floor(Math.min((room.width - 24) / w, (room.height - 24) / R.length)))) : 12
    // in parts mode: each pixel tinted by its part (the brush's part brightest), its own light and dark kept
    drawFlat(
      canvas,
      zoom,
      mode === 'parts'
        ? (r, c, rgb) => {
            const k = partOf(R[r][c])
            const tint = k < 0 ? [0.45, 0.45, 0.45] : hex(PART_TINTS[k % PART_TINTS.length])
            const l = 0.35 + 0.9 * (0.3 * rgb[0] + 0.55 * rgb[1] + 0.15 * rgb[2])
            const dim = k === partBrush ? 1 : 0.55
            return tint.map((v) => v * l * dim)
          }
        : undefined,
    )
    if (grid && zoom >= 6) {
      ctx.strokeStyle = '#ffffff12'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let c = 1; c < w; c++) (ctx.moveTo(c * zoom + 0.5, 0), ctx.lineTo(c * zoom + 0.5, R.length * zoom))
      for (let r = 1; r < R.length; r++) (ctx.moveTo(0, r * zoom + 0.5), ctx.lineTo(w * zoom, r * zoom + 0.5))
      ctx.stroke()
    }
    // the ground line (sprites stand on their bottom row; a prop on its foot row) and a prop's anchor column
    const groundRow = R.length - (target.anchor?.foot() ?? 0)
    ctx.strokeStyle = '#f08a3c88'
    ctx.beginPath()
    ctx.moveTo(0, groundRow * zoom - 0.5)
    ctx.lineTo(w * zoom, groundRow * zoom - 0.5)
    ctx.stroke()
    if (target.anchor) {
      ctx.fillStyle = '#f08a3c33'
      ctx.fillRect(target.anchor.get() * zoom, 0, zoom, R.length * zoom)
      ctx.fillStyle = '#f08a3c66'
      ctx.fillRect(target.anchor.get() * zoom, (groundRow - 1) * zoom, zoom, zoom) // the spot it stands on
    }
    // previews: shaded under the light, normals, parts
    const parts = (target.parts() ?? []) as Part[]
    const nm = parts.length ? partNormals(R, parts, resolved()) : null
    const pz = Math.max(2, Math.min(6, Math.floor(160 / Math.max(w, R.length))))
    const L = [light.x, light.y, Math.sqrt(Math.max(0, 1 - light.x ** 2 - light.y ** 2))]
    const n = (r: number, c: number) => {
      if (!nm) return [0, 0, 1]
      const i = (r + 2) * nm.w + c + 2
      return [nm.nx[i], nm.ny[i], nm.nz[i]]
    }
    drawFlat(previews.shaded, pz, (r, c, rgb) => {
      const N = n(r, c)
      const s = 0.22 + Math.max(0, N[0] * L[0] + N[1] * L[1] + N[2] * L[2])
      return [rgb[0] * s * 1.08, rgb[1] * s, rgb[2] * s * 0.9]
    })
    drawScene(previews.scene, pz)
    drawFlat(previews.normals, pz, (r, c) => {
      const N = n(r, c)
      return [N[0] * 0.5 + 0.5, N[1] * 0.5 + 0.5, N[2]]
    })
    drawFlat(previews.parts, pz, (r, c) => {
      const ch = R[r][c]
      const k = parts.findIndex((p) => p.chars.includes(ch))
      return k < 0 ? [0.4, 0.4, 0.4] : hex(PART_TINTS[k % PART_TINTS.length])
    })
    renderPalette()
    renderParts()
    sizeLabel.textContent = `${w} × ${R.length}`
  }

  // ---------------------------------------------------------------- the light pad
  const pad = h('canvas', { class: 'light-pad', width: 64, height: 64, title: 'drag to move the light' })
  const drawPad = () => {
    const x = pad.getContext('2d')!
    x.clearRect(0, 0, 64, 64)
    x.strokeStyle = '#3a3e45'
    x.beginPath()
    x.arc(32, 32, 30, 0, Math.PI * 2)
    x.stroke()
    x.fillStyle = '#f08a3c'
    x.beginPath()
    x.arc(32 + light.x * 30, 32 - light.y * 30, 4, 0, Math.PI * 2)
    x.fill()
  }
  const movePad = (e: PointerEvent) => {
    const b = pad.getBoundingClientRect()
    let x = ((e.clientX - b.left) / b.width) * 2 - 1
    let y = -(((e.clientY - b.top) / b.height) * 2 - 1)
    const l = Math.hypot(x, y)
    if (l > 0.98) ((x *= 0.98 / l), (y *= 0.98 / l))
    light.x = x
    light.y = y
    drawPad()
    draw()
  }
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId)
    movePad(e)
  })
  pad.addEventListener('pointermove', (e) => e.buttons && movePad(e))
  drawPad()

  // ---------------------------------------------------------------- toolbar
  const toolBtns = (
    [
      ['pencil', 'B', 'paint with the brush (right-click erases)'],
      ['erase', 'E', 'erase to transparent'],
      ['pick', 'I', 'pick a colour from the art'],
      ['fill', 'F', 'fill an area'],
      ['anchor', 'A', 'set where a prop stands: its column, and the row that sits on the ground (rows below come toward you)'],
    ] as const
  ).map(([t, key, hint]) => h('button', { 'data-tool': t, title: `${hint} (${key})`, onclick: () => setTool(t) }, t))
  const setTool = (t: Tool) => {
    if (mode === 'parts' && (t === 'erase' || t === 'anchor')) return
    tool = t
    for (const b of toolBtns) b.setAttribute('aria-pressed', String(b.dataset.tool === t))
  }
  const modeBtns = (
    [
      ['colours', 'paint colours'],
      ['parts', 'paint pixels into parts: the shapes their light follows (P)'],
    ] as const
  ).map(([m, hint]) => h('button', { 'data-mode': m, title: hint, onclick: () => setMode(m) }, m))
  const setMode = (m: Mode) => {
    if (m === 'parts' && !target.parts()) return
    mode = m
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === m))
    for (const b of toolBtns) b.disabled = m === 'parts' && (b.dataset.tool === 'erase' || b.dataset.tool === 'anchor')
    if (m === 'parts' && (tool === 'erase' || tool === 'anchor')) setTool('pencil')
    center.classList.toggle('parts-mode', m === 'parts')
    draw()
  }
  const sizeLabel = h('span', { class: 'dim' })
  const edgeBtns = (['top', 'bottom', 'left', 'right'] as const).map((edge) =>
    h(
      'span',
      { class: 'edge' },
      h('span', { class: 'dim' }, edge),
      h('button', { title: `add a ${edge === 'top' || edge === 'bottom' ? 'row' : 'column'} at the ${edge}`, onclick: () => resize(edge, true) }, '+'),
      h('button', { title: `remove the ${edge} ${edge === 'top' || edge === 'bottom' ? 'row' : 'column'}`, onclick: () => resize(edge, false) }, '−'),
    ),
  )
  const toolbar = h(
    'div',
    { class: 'art-tools' },
    h('div', { class: 'seg' }, ...modeBtns),
    h('div', { class: 'seg' }, ...toolBtns),
    h('button', { title: 'undo (⌘Z)', onclick: () => restore(undo, redo) }, 'undo'),
    h('button', { title: 'redo (⇧⌘Z)', onclick: () => restore(redo, undo) }, 'redo'),
    h(
      'label',
      { class: 'row check' },
      h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => ((grid = (e.target as HTMLInputElement).checked), draw()) }),
      h('span', {}, 'grid'),
    ),
    sizeLabel,
    ...edgeBtns,
    status,
  )
  window.addEventListener('keydown', (e) => {
    if (!center.isConnected || center.hidden || (e.target as HTMLElement).closest('input, select, textarea')) return
    const k = e.key.toLowerCase()
    if ((e.metaKey || e.ctrlKey) && k === 'z') {
      e.preventDefault()
      return e.shiftKey ? restore(redo, undo) : restore(undo, redo)
    }
    if (k === 'p' && !e.metaKey && !e.ctrlKey) return setMode(mode === 'parts' ? 'colours' : 'parts')
    const t = ({ b: 'pencil', e: 'erase', i: 'pick', f: 'fill', a: 'anchor' } as Record<string, Tool>)[k]
    if (t && !e.metaKey && !e.ctrlKey) setTool(t)
  })

  // ---------------------------------------------------------------- palette and parts
  const paletteSelect = h('select', {
    onchange: (e: Event) => {
      paletteName = variant = (e.target as HTMLSelectElement).value
      draw()
    },
  })
  const paletteList = h('div', { class: 'pal' })
  const setBrush = (ch: string) => {
    brush = ch
    if (tool === 'erase' || tool === 'pick') setTool('pencil')
    renderPalette()
  }
  const worldNames = Object.keys(DATA.palette)
  function renderPalette() {
    const pals = target.palettes()
    paletteSelect.replaceChildren(...Object.keys(pals).map((k) => h('option', { value: k, selected: k === paletteName }, k)))
    const pal = palette()
    const used = new Set(rows().join('').replace(/\./g, ''))
    const shine = target.shine()
    const depth = target.depth?.()
    const chars = [...new Set([...Object.keys(pal), ...used])].sort()
    const missing = chars.filter((ch) => pal[ch] === undefined)
    paletteList.replaceChildren(
      h(
        'div',
        { class: 'pal-head dim' },
        h('span', {}, 'char · colour · link'),
        h('span', {}, [shine && 'shine', 'glow', depth && 'set back'].filter(Boolean).join(' · ')),
      ),
      ...(missing.length ? [h('p', { class: 'warn' }, `not in the ${paletteName} palette (shown magenta): ${missing.join(' ')}`)] : []),
      ...chars.map((ch) => {
        const v = pal[ch]
        const missing = v === undefined
        const color = h('input', { type: 'color', value: colorOf(ch) ?? '#ff00ff', title: 'colour' }) as HTMLInputElement
        color.addEventListener('input', () => {
          pal[ch] = color.value
          touch(false)
        })
        color.addEventListener('change', () => touch(true))
        const link = h('select', { title: 'link to a world colour (it follows when the world colour changes)' })
        link.append(
          h('option', { value: '' }, 'own colour'),
          ...(v?.startsWith('=') ? [h('option', { value: v, selected: true }, `same as ${v.slice(1)}`)] : []),
          ...worldNames.map((n) => h('option', { value: n, selected: v === `$${n}` }, `$${n}`)),
        )
        link.addEventListener('change', () => {
          pal[ch] = link.value.startsWith('=') ? link.value : link.value ? `$${link.value}` : (colorOf(ch) ?? '#ff00ff')
          touch(true)
        })
        const shineIn =
          shine &&
          (h('input', {
            type: 'number',
            min: 0,
            max: 1,
            step: 0.05,
            value: shine[ch] ?? 0,
            title: 'shine (how much it gleams)',
            class: 'num',
          }) as HTMLInputElement)
        const glow = target.glow()
        const glowIn = h('input', {
          type: 'number',
          min: 0,
          max: 1,
          step: 0.05,
          value: glow[ch] ?? 0,
          title: 'glow (lights up at night: 0 = not at all)',
          class: `num glow${glow[ch] ? ' on' : ''}`,
        }) as HTMLInputElement
        glowIn.addEventListener('change', () => {
          const g = Number(glowIn.value)
          if (g > 0) glow[ch] = g
          else delete glow[ch]
          touch(true)
        })
        const depthIn =
          depth &&
          (h('input', {
            type: 'number',
            min: -10,
            max: 0,
            step: 0.5,
            value: depth[ch] ?? 0,
            title: 'set back (world units behind the front: a doorway you see into, that shroomfolk walk into)',
            class: 'num',
          }) as HTMLInputElement)
        depthIn?.addEventListener('change', () => {
          const d = Number(depthIn.value)
          if (d < 0) depth![ch] = d
          else delete depth![ch]
          touch(true)
        })
        shineIn?.addEventListener('change', () => {
          const s = Number(shineIn.value)
          if (s > 0) shine![ch] = s
          else delete shine![ch]
          touch(true)
        })
        return h(
          'div',
          { class: `pal-row${ch === brush ? ' on' : ''}${missing ? ' missing' : ''}`, title: missing ? 'used in the art but not in the palette' : '' },
          h('button', { class: 'ch', title: 'paint with this', onclick: () => setBrush(ch) }, ch),
          color,
          link,
          shineIn,
          glowIn,
          depthIn,
          h(
            'button',
            {
              title: used.has(ch) ? 'still used in this frame' : 'remove from the palette',
              disabled: used.has(ch),
              onclick: () => {
                delete pal[ch]
                touch(true)
              },
            },
            '×',
          ),
        )
      }),
      h(
        'button',
        {
          onclick: () => {
            const free = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').find((c) => !(c in pal) && !used.has(c))
            if (!free) return
            pal[free] = '#888888'
            setBrush(free)
            touch(true)
          },
        },
        '+ colour',
      ),
    )
  }
  const partsList = h('div', { class: 'parts' })
  function renderParts() {
    const parts = target.parts()
    if (!parts) {
      partsList.replaceChildren(h('p', { class: 'dim' }, 'This art is flat (no parts, no normals).'))
      return
    }
    const used = new Set(rows().join('').replace(/\./g, ''))
    const assigned = new Set(parts.flatMap((p) => [...p.chars]))
    const loose = [...used].filter((c) => !assigned.has(c))
    partsList.replaceChildren(
      h(
        'p',
        { class: 'dim' },
        mode === 'parts'
          ? 'Paint pixels into the chosen part (click a swatch to choose). A pixel that moves gets a twin letter: the same colour, in its new part.'
          : 'Each part is a patch of these chars, shaped as one form. Its normals follow that shape; its texture and relief add bumps (relief also turns the painted light and dark into bumps).',
      ),
      ...parts.map((p, i) => {
        const chars = h('input', { type: 'text', value: p.chars, title: 'the chars in this part', class: 'chars' }) as HTMLInputElement
        chars.addEventListener('change', () => {
          p.chars = chars.value.replace(/[\s.]/g, '')
          touch(true)
        })
        const kind = h('select', { title: 'its shape' })
        kind.append(...KINDS.map((k) => h('option', { value: k, selected: k === p.kind }, k)))
        kind.addEventListener('change', () => {
          p.kind = kind.value
          touch(true)
        })
        const texture = h('select', { title: 'its texture (with relief, how strongly it bumps the light)' })
        texture.append(...TEXTURES.map((t) => h('option', { value: t, selected: t === (p.texture ?? 'none') }, t)))
        texture.addEventListener('change', () => {
          if (texture.value === 'none') delete p.texture
          else {
            p.texture = texture.value
            if (!p.relief) p.relief = 0.5 // a texture with no relief would do nothing
          }
          touch(true)
        })
        const relief = h('input', {
          type: 'number',
          min: 0,
          max: 2,
          step: 0.05,
          value: p.relief ?? 0,
          title: 'relief: how strongly its texture and its painted light and dark bump the light (0 = smooth)',
          class: 'num',
        }) as HTMLInputElement
        relief.addEventListener('change', () => {
          const v = Number(relief.value)
          if (v > 0) p.relief = v
          else delete p.relief
          touch(true)
        })
        return h(
          'div',
          { class: `part-row${mode === 'parts' && i === partBrush ? ' on' : ''}` },
          h('button', {
            class: 'sw',
            title: 'paint into this part (parts mode)',
            style: `background:${PART_TINTS[i % PART_TINTS.length]}`,
            onclick: () => {
              partBrush = i
              if (mode !== 'parts') setMode('parts')
              else draw()
            },
          }),
          chars,
          kind,
          h('span', { class: 'part-tex' }, texture, relief),
          h(
            'button',
            {
              title: 'remove this part',
              onclick: () => {
                parts.splice(i, 1)
                partBrush = Math.min(partBrush, Math.max(0, parts.length - 1))
                touch(true)
              },
            },
            '×',
          ),
        )
      }),
      ...(loose.length ? [h('p', { class: 'warn' }, `not in any part (shaded as one dome): ${loose.join(' ')}`)] : []),
      h(
        'button',
        {
          onclick: () => {
            remember()
            parts.push({ chars: mode === 'parts' ? '' : loose.join(''), kind: 'dome' })
            if (mode === 'parts') partBrush = parts.length - 1
            touch(true)
          },
        },
        '+ part',
      ),
    )
  }

  // ---------------------------------------------------------------- assets
  const left = h('div', { class: 'assets' })
  const groups = [...new Set(all.map((t) => t.group))]
  for (const g of groups)
    left.append(
      h(
        'section',
        {},
        h('h3', {}, g),
        ...all
          .filter((t) => t.group === g)
          .map((t) =>
            h(
              'button',
              {
                class: 'asset',
                'data-id': t.id,
                onclick: () => {
                  target = t
                  if (mode === 'parts' && !t.parts()) setMode('colours')
                  partBrush = Math.min(partBrush, Math.max(0, (t.parts()?.length ?? 1) - 1))
                  choosePalette()
                  brush = rows().join('').replace(/\./g, '')[0] ?? Object.keys(palette())[0] ?? ''
                  for (const b of left.querySelectorAll<HTMLButtonElement>('.asset')) b.setAttribute('aria-pressed', String(b.dataset.id === t.id))
                  draw()
                },
              },
              t.label,
            ),
          ),
      ),
    )
  left.querySelector('.asset')?.setAttribute('aria-pressed', 'true')

  const right = h(
    'div',
    { class: 'art-side' },
    h('section', {}, h('h3', {}, 'palette'), h('div', { class: 'row' }, h('span', { class: 'dim' }, 'variant'), paletteSelect), paletteList),
    h('section', {}, h('h3', {}, 'parts'), partsList),
  )

  const pip = h('div', { class: 'pip' })
  const center = h(
    'div',
    { class: 'art' },
    toolbar,
    h('div', { class: 'art-main' }, h('div', { class: 'art-board' }, canvas)),
    h(
      'div',
      { class: 'art-previews' },
      h(
        'figure',
        { title: 'at night: where it stands (its anchor, for props) and what glows (the glow column)' },
        previews.scene,
        h('figcaption', {}, 'in the scene ', h('span', { class: 'stands' }, '▲ stands here')),
      ),
      h('figure', {}, previews.shaded, h('figcaption', {}, 'shaded')),
      h('figure', {}, pad, h('figcaption', {}, 'light')),
      h('figure', {}, previews.normals, h('figcaption', {}, 'normals')),
      h('figure', {}, previews.parts, h('figcaption', {}, 'parts')),
      pip,
    ),
  )
  setTool('pencil')
  for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === mode))
  choosePalette()
  brush = rows().join('').replace(/\./g, '')[0] ?? ''
  new ResizeObserver(() => center.isConnected && draw()).observe(center)
  return { center, left, right, pip, refresh: draw }
}
