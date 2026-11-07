/**
 * The art, live. Sprite and prop art, palettes, parts and light defaults live as JSON in
 * data/ (so the editor saves data, never code; sound tuning too). This module loads them, resolves palettes
 * into colours, and keeps every object the renderer uses *the same object* the editor edits:
 * changing a row, a colour or a part shows on the next frame.
 *
 * Palettes are hex strings; "$name" means the world palette's colour `name`, and stays linked
 * to it (edit the world colour and every palette using it follows).
 */
import familiesData from './data/families.json'
import layoutData from './data/layout.json'
import lightsData from './data/lights.json'
import paletteData from './data/palette.json'
import propsData from './data/props.json'
import soundData from './data/sound.json'
import spritesData from './data/sprites.json'
import type { Part, PartKind } from './normals'
import { hex, type Color } from './util'

export type Rows = readonly string[]
export type Palette = Record<string, Color>
export type HexPalette = Record<string, string>

export interface PartData {
  chars: string
  kind: string
  relief?: number
  texture?: string
}
/** A drawn surface's texture (materials.ts) and how strongly it bumps the light (0..1). */
export interface Surface {
  texture: string
  relief: number
}
/** The pale speckles and rim dots on foliage: how many (1 = all), how pale (1 = full), how much they glint. */
export interface Highlights {
  amount: number
  strength: number
  glint: number
}
/** A generated family (data/families.json): its surfaces, and for foliage its highlights. */
/** The moon's own sun (it lights only the moon; its phase and angle come from the moon's night, moon.ts): how much of the dark side still shows. */
export interface Sun {
  earthshine: number
}
/** The moon's night: how long a crossing takes and how long it stays hidden behind the stone (seconds). */
export interface MoonPath {
  crossing: number
  hidden: number
}
/** How strongly the moon lights the scene (scaled by its phase, its height and the clouds). */
export interface Moonlight {
  /** The cool fill everywhere (the old ambient). */
  fill: number
  /** The soft key from overhead. */
  key: number
  /** Highlights on whatever faces the moon. */
  highlights: number
  /** How dark its shadows are (faint). */
  shadows?: number
}
/**
 * Depth in foliage: each lobe a dome of leaf clumps (`size` px across) with their own normals
 * (`clumps`: how much they show), painted depth (`paint`: back lobes darker, tops lighter,
 * undersides, crevices and contact shadows darker), lighter leaves (`lift`) so the light has
 * room to work, and a sheen on the clump tops (`sheen`: the moon, and the fire, catch them).
 */
export interface FoliageDepth {
  clumps: number
  size: number
  paint: number
  lift: number
  sheen: number
}
export interface Family {
  surfaces: Record<string, Surface>
  highlights?: Highlights
  depth?: FoliageDepth
  sun?: Sun
  light?: Moonlight
  path?: MoonPath
}
export interface SpriteData {
  frames: Record<string, string[]>
  palettes: Record<string, HexPalette>
  parts: PartData[]
  shine: Record<string, number>
  /** Which chars glow at night, and how strongly (0..1); how they glow is the renderer's (a lantern flickers, a glowcap pulses). */
  glow?: Record<string, number>
}
export interface PropData {
  rows: string[]
  anchor: number
  palette: HexPalette
  parts: PartData[]
  shine: Record<string, number>
  glow?: Record<string, number>
  /** Chars set back behind the art's front, in world units (a doorway you see into). */
  depth?: Record<string, number>
}
export interface RelicData {
  rows: string[]
  palette: HexPalette
  glow?: Record<string, number>
}

interface Spot {
  x: number
  z: number
}
/** Where everything stands. */
export interface Layout {
  props: {
    knight: Spot
    sword: Spot
    pack: Spot
    woodpile: Spot
    huts: Spot[]
    graves: (Spot & { helm?: boolean })[]
    lantern: Spot
    trigon: Spot
  }
  hearthstones: (Spot & { h: number; w: number; lean: number; carved: boolean })[]
  trees: (Spot & { h: number; w: number; seed: number; tone: number })[]
  bushes: (Spot & { w: number; h: number; seed: number; lobes: number })[]
  /** Small things: ferns, grass, foxgloves, rocks, stumps, fallen logs, mushroom clusters. */
  details: (Spot & { kind: string; size: number; seed: number })[]
}

/** The raw data, exactly what's in data/*.json. The editor edits this and saves it. */
export const DATA = {
  sprites: spritesData as unknown as Record<string, SpriteData>,
  props: propsData as unknown as Record<string, PropData> & { relics: Record<string, RelicData> },
  palette: paletteData as Record<keyof typeof paletteData, string>,
  lights: lightsData as Record<string, Record<string, unknown>>,
  layout: layoutData as Layout,
  sound: soundData as Record<string, Record<string, unknown>>,
  families: familiesData as Record<string, Family>,
}

const MISSING: Color = [1, 0, 1]

/** The world palette, resolved. Colours are updated in place when edited. */
export const WORLD = Object.fromEntries(Object.entries(DATA.palette).map(([k, v]) => [k, hex(v)])) as Record<keyof typeof paletteData, Color>

/** Resolve one palette entry: a hex colour, or "$name" for a world colour (the same object, so it stays linked). */
export const resolveColor = (v: string): Color => (v.startsWith('$') ? ((WORLD as Record<string, Color>)[v.slice(1)] ?? MISSING) : hex(v))

/**
 * Resolve a palette into `into` (in place, so whoever holds it sees the change). An entry can be
 * "=x": the same colour as char x (a twin, made so some pixels can be in another part).
 */
export function resolvePalette(p: HexPalette, into: Palette = {}): Palette {
  for (const k of Object.keys(into)) if (!(k in p)) delete into[k]
  for (const [ch, v] of Object.entries(p)) if (!v.startsWith('=')) into[ch] = resolveColor(v)
  for (const [ch, v] of Object.entries(p)) if (v.startsWith('=')) into[ch] = into[v.slice(1)] ?? MISSING
  return into
}

const asParts = (p: PartData[]) => p as Part[] & { kind?: PartKind }[]

/** A sprite, ready to draw: frames (the data's own arrays), resolved palettes, parts, shine. */
export interface SpriteAsset {
  frames: Record<string, Rows>
  palettes: Record<string, Palette>
  parts: Part[]
  shine: Record<string, number>
  glow: Record<string, number>
}
export const SPRITES: Record<string, SpriteAsset> = Object.fromEntries(
  Object.entries(DATA.sprites).map(([name, d]) => [
    name,
    {
      frames: d.frames,
      palettes: Object.fromEntries(Object.entries(d.palettes).map(([k, p]) => [k, resolvePalette(p)])),
      parts: asParts(d.parts),
      shine: d.shine,
      glow: (d.glow ??= {}),
    },
  ]),
)

/** A prop's art: rows, the column its anchor sits on, palette, parts, and per-char shine. */
export interface PropArt {
  rows: Rows
  anchor: number
  pal: Palette
  parts: Part[]
  shine?: Record<string, number>
  glow: Record<string, number>
  depth?: Record<string, number>
}

/** Every prop's art, by name: the objects the renderer draws, kept in step with the data. */
export const PROP_ART: Record<string, PropArt> = {}
/** The relics' art. */
export const RELIC_ART = {} as Record<'antler' | 'crook' | 'key', { rows: Rows; pal: Palette; glow: Record<string, number> }>

function syncProps() {
  for (const [k, d] of Object.entries(DATA.props)) {
    if (k === 'relics') continue
    const p = d as PropData
    const a = (PROP_ART[k] ??= { rows: p.rows, anchor: p.anchor, pal: {}, parts: p.parts as Part[], shine: p.shine, glow: (p.glow ??= {}) })
    a.rows = p.rows
    a.anchor = p.anchor
    a.parts = p.parts as Part[]
    a.shine = p.shine
    a.glow = p.glow ??= {}
    a.depth = p.depth
    resolvePalette(p.palette, a.pal)
  }
  for (const [k, r] of Object.entries(DATA.props.relics)) {
    const a = (RELIC_ART[k as keyof typeof RELIC_ART] ??= { rows: r.rows, pal: {}, glow: (r.glow ??= {}) })
    a.rows = r.rows
    a.glow = r.glow ??= {}
    resolvePalette(r.palette, a.pal)
  }
}
syncProps()

// ---------------------------------------------------------------- editing

/** The data files the editor can edit and save (data/<file>.json). */
export const FILES = ['sprites', 'props', 'palette', 'lights', 'layout', 'sound', 'families'] as const
export type DataFile = (typeof FILES)[number]

const listeners = new Set<(file: DataFile) => void>()
/** Be told when a data file changes (to rebuild what's derived from it). */
export function onArtChange(fn: (file: DataFile) => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** A deep copy of one data file as it is now. */
export const snapshot = (file: DataFile): unknown => structuredClone(DATA[file])

/** Replace the contents of `into` with `from`, keeping `into` (and its arrays) the same objects. */
function replaceInPlace(into: Record<string, unknown>, from: Record<string, unknown>) {
  for (const k of Object.keys(into)) if (!(k in from)) delete into[k]
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k]
    if (Array.isArray(v) && Array.isArray(cur)) cur.splice(0, cur.length, ...structuredClone(v))
    else if (v && typeof v === 'object' && cur && typeof cur === 'object' && !Array.isArray(cur))
      replaceInPlace(cur as Record<string, unknown>, v as Record<string, unknown>)
    else into[k] = structuredClone(v)
  }
}

/**
 * Put new contents into a data file, live: everything holding its objects sees the change.
 * World colours change in place, so palettes linked to them follow.
 */
export function applyData(file: DataFile, data: unknown) {
  replaceInPlace(DATA[file] as Record<string, unknown>, data as Record<string, unknown>)
  changed(file)
}

/** Re-derive everything from the data after it was edited in place, and tell listeners. */
export function changed(file: DataFile) {
  if (file === 'palette') {
    for (const [k, v] of Object.entries(DATA.palette)) {
      const c = hex(v)
      const w = ((WORLD as Record<string, Color>)[k] ??= c)
      w[0] = c[0]
      w[1] = c[1]
      w[2] = c[2]
    }
  }
  // palettes and prop views (also after a world colour changed, for any new "$" links)
  for (const [name, d] of Object.entries(DATA.sprites)) {
    const a = SPRITES[name]
    if (!a) continue
    a.frames = d.frames
    a.parts = asParts(d.parts)
    a.shine = d.shine
    a.glow = d.glow ??= {}
    for (const [k, p] of Object.entries(d.palettes)) resolvePalette(p, (a.palettes[k] ??= {}))
  }
  syncProps()
  for (const fn of listeners) fn(file)
}
