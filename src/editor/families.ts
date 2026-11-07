/**
 * The families view: the things the renderer generates rather than draws from art (trees,
 * bushes, rocks, stones), tuned family by family against the live scene. For now each family's
 * surfaces: which texture they have and how strongly it bumps the light. Edits data/families.json,
 * live and staged.
 */
import { DATA, changed, type DataFile, type FoliageDepth, type Highlights, type MoonPath, type Moonlight, type Sun, type Surface } from '../art'
import { PHASES, moonTiming } from '../moon'
import { TEXTURES, textureAt } from '../materials'

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

/** What each family is called and what it is, for the list. */
const ABOUT: Record<string, [string, string]> = {
  tree: ['trees', 'the forest: a trunk and a crown of leafy lobes'],
  bush: ['bushes', 'brambles, holly, thickets: mounds of leafy lobes'],
  rock: ['rocks', 'mossy stones half sunk in the ground'],
  stump: ['stumps', 'old stumps among the trees'],
  log: ['fallen logs', 'soft with moss'],
  grave: ['graves', 'the standing stones in the quiet grove'],
  trigon: ['the trigon', 'the old stone with the triangle cut into it'],
  stoneRing: ['the stone ring', 'the stones round the fire'],
  hearthstone: ['hearthstones', 'the tall carved stones by the fire'],
  moon: ['the moon', 'lit by its own sun, which lights nothing else'],
}

export interface FamiliesEditor {
  /** The list of families (left). */
  left: HTMLElement
  /** The chosen family's settings (right). */
  right: HTMLElement
  refresh(): void
  /** Keep live readouts (the moon's time) up to date; call often. */
  tick(): void
}

/** The live moon, to preview a time or a phase (from the running scene). */
export interface MoonControl {
  get(): { t: number; phase: number } | null
  set(m: { t?: number; phase?: number }): void
}

const PHASE_NAMES = ['waxing crescent', 'first quarter', 'waxing gibbous', 'full', 'waning gibbous', 'last quarter', 'waning crescent', 'old moon']

export function createFamiliesEditor(edited: (file: DataFile) => void, moon: MoonControl): FamiliesEditor {
  const data = () => DATA.families
  let chosen = Object.keys(data())[0]
  // live while dragging (the static layer rebuilds, so not every frame), staged when let go
  let timer = 0
  const touch = (final: boolean) => {
    if (final) {
      window.clearTimeout(timer)
      timer = 0
      edited('families')
    } else if (!timer)
      timer = window.setTimeout(() => {
        timer = 0
        changed('families')
      }, 150)
    drawSwatches()
  }

  // ---------------------------------------------------------------- texture swatches
  const swatches: [HTMLCanvasElement, Surface][] = []
  /** A patch of the texture, bump-lit from the upper left, as the scene lights it. */
  const drawSwatch = (c: HTMLCanvasElement, s: Surface) => {
    const N = 40
    const z = 2
    c.width = c.height = N * z
    const x = c.getContext('2d')!
    const hgt = (px: number, py: number) => textureAt(s.texture, px, py, 7)
    for (let py = 0; py < N; py++)
      for (let px = 0; px < N; px++) {
        const sx = (hgt(px + 1, py) - hgt(px - 1, py)) * 0.5
        const sy = (hgt(px, py + 1) - hgt(px, py - 1)) * 0.5
        const nx = -sx * 1.6 * s.relief
        const ny = sy * 1.6 * s.relief
        const l = Math.hypot(nx, ny, 1)
        const lit = Math.max(0, (nx * -0.55 + ny * 0.45 + 0.7) / l)
        const v = Math.round(Math.min(1, 0.15 + 0.75 * lit) * 255)
        x.fillStyle = `rgb(${v},${Math.round(v * 0.92)},${Math.round(v * 0.82)})`
        x.fillRect(px * z, py * z, z, z)
      }
  }
  const drawSwatches = () => swatches.forEach(([c, s]) => drawSwatch(c, s))

  // ---------------------------------------------------------------- the list
  const left = h('div', { class: 'assets' })
  const renderList = () =>
    left.replaceChildren(
      h(
        'section',
        {},
        h('h3', {}, 'families'),
        ...Object.keys(data()).map((k) =>
          h(
            'button',
            {
              class: 'asset',
              'aria-pressed': String(k === chosen),
              title: ABOUT[k]?.[1] ?? '',
              onclick: () => {
                chosen = k
                render()
              },
            },
            ABOUT[k]?.[0] ?? k,
          ),
        ),
      ),
    )

  // ---------------------------------------------------------------- the chosen family
  const right = h('div', { class: 'families' })
  const renderFamily = () => {
    swatches.length = 0
    const fam = data()[chosen]
    if (!fam) return void right.replaceChildren()
    /** A 0..max slider for one number, live while dragging and staged when let go. */
    const slider = (label: string, title: string, get: () => number, set: (v: number) => void, max = 1, step = 0.05) => {
      const digits = step >= 1 ? 0 : step < 0.01 ? 3 : 2
      const value = h('span', { class: 'dim num-out' }, get().toFixed(digits))
      const input = h('input', { type: 'range', min: 0, max, step, value: get(), title }) as HTMLInputElement
      input.addEventListener('input', () => {
        set(Number(input.value))
        value.textContent = get().toFixed(digits)
        touch(false)
      })
      input.addEventListener('change', () => touch(true))
      return h('label', { class: 'row', title }, h('span', { class: 'dim' }, label), input, value)
    }
    const hl = fam.highlights
    const DEPTH: [keyof FoliageDepth, string, string, number, number][] = [
      ['clumps', 'clumps', 'how much each leaf clump shows as its own little dome', 1.5, 0.05],
      ['size', 'clump size', 'how big the leaf clumps are (pixels)', 14, 1],
      ['paint', 'painted depth', 'back lobes darker, tops lighter, undersides, crevices and contact shadows darker', 2, 0.05],
      ['lift', 'leaf lightness', 'how light the leaves are (so the light and depth have room to work)', 3, 0.05],
      ['sheen', 'sheen', 'how much the clump tops catch the moon (and the fire)', 1, 0.05],
    ]
    const LIGHT: [keyof Moonlight, string, string, number][] = [
      ['fill', 'fill', 'the cool moonlight everywhere (the old ambient)', 1.5],
      ['key', 'overhead', 'the soft light from straight above, on the tops of things', 1],
      ['highlights', 'highlights', 'the catches on whatever faces the moon', 1.5],
      ['shadows', 'shadows', 'how dark its shadows are (faint)', 1],
    ]
    const SUN: [keyof Sun, string, string, number, number][] = [['earthshine', 'earthshine', 'how much of the dark side still shows', 0.2, 0.005]]
    const PATH: [keyof MoonPath, string, string, number, number, number][] = [
      ['crossing', 'crossing', 'minutes to cross the sky, from the treeline to the stone', 30, 0.5, 60],
      ['hidden', 'hidden', 'seconds it stays behind the stone (the hush)', 120, 5, 1],
    ]
    const HL: [keyof Highlights, string, string][] = [
      ['amount', 'amount', 'how many pale speckles and rim dots (1 = as first drawn)'],
      ['strength', 'strength', 'how pale they are (0 = the leaf colour, 1 = full)'],
      ['glint', 'glint', 'how much they catch the moonlight'],
    ]
    right.replaceChildren(
      h('h3', {}, ABOUT[chosen]?.[0] ?? chosen),
      h('p', { class: 'dim' }, ABOUT[chosen]?.[1] ?? ''),
      h('h3', {}, 'surfaces'),
      h(
        'p',
        { class: 'dim' },
        'Each surface has a texture, and relief: how strongly it bumps the light. It shows most where a light falls across it (by the fire).',
      ),
      ...(fam.path
        ? [
            h('h3', {}, 'its night'),
            h(
              'p',
              { class: 'dim' },
              'It rises behind the trees on the left, crosses over the clearing, and sinks behind the old stone; it rises again in its next phase.',
            ),
            ...PATH.map(([k, label, title, max, step, unit]) =>
              slider(
                label,
                title,
                () => fam.path![k] / unit,
                (v) => (fam.path![k] = Math.max(step, v) * unit),
                max,
                step,
              ),
            ),
            h('h3', {}, 'preview'),
            h('p', { class: 'dim' }, 'Move the moon now (not saved): where it is in its night, and its phase.'),
            previewTime,
            previewPhase,
          ]
        : []),
      ...(fam.sun
        ? [
            h('h3', {}, 'sun'),
            h('p', { class: 'dim' }, 'Its own sun: it lights the moon and nothing else.'),
            ...SUN.map(([k, label, title, max, step]) =>
              slider(
                label,
                title,
                () => fam.sun![k],
                (v) => (fam.sun![k] = v),
                max,
                step,
              ),
            ),
          ]
        : []),
      ...(fam.light
        ? [
            h('h3', {}, 'moonlight'),
            h('p', { class: 'dim' }, 'How the moon lights the scene. Its phase, its height and the clouds scale them all.'),
            ...LIGHT.map(([k, label, title, max]) =>
              slider(
                label,
                title,
                () => fam.light![k] ?? 0,
                (v) => (fam.light![k] = v),
                max,
              ),
            ),
          ]
        : []),
      ...(fam.footprint !== undefined
        ? [
            h('h3', {}, 'shape'),
            slider(
              'footprint',
              'seen from a little above: how far the front of its footprint curves toward you (0: side on)',
              () => fam.footprint ?? 0,
              (v) => (fam.footprint = v),
              0.6,
            ),
          ]
        : []),
      ...(fam.depth
        ? [
            h('h3', {}, 'depth'),
            h('p', { class: 'dim' }, 'Each lobe a dome of leaf clumps with its own light and shade.'),
            ...DEPTH.map(([k, label, title, max, step]) =>
              slider(
                label,
                title,
                () => fam.depth![k],
                (v) => (fam.depth![k] = v),
                max,
                step,
              ),
            ),
          ]
        : []),
      ...(hl
        ? [
            h('h3', {}, 'highlights'),
            h(
              'p',
              { class: 'dim' },
              'The pale speckles on the leaves (and the dotted rims on bushes). With the leaves textured, fewer lets the light do the work.',
            ),
            ...HL.map(([k, label, title]) =>
              slider(
                label,
                title,
                () => hl[k],
                (v) => (hl[k] = v),
              ),
            ),
          ]
        : []),
      ...Object.entries(fam.surfaces).map(([name, s]) => {
        const kind = h('select', { title: 'texture' })
        kind.append(...TEXTURES.map((t) => h('option', { value: t, selected: t === s.texture }, t)))
        kind.addEventListener('change', () => {
          s.texture = kind.value
          touch(true)
        })
        const relief = slider(
          'relief',
          'how strongly the texture bumps the light',
          () => s.relief,
          (v) => (s.relief = v),
          2,
        )
        const swatch = h('canvas', { class: 'tex-swatch', title: 'the texture, lit from the upper left' })
        swatches.push([swatch, s])
        return h('div', { class: 'surface' }, swatch, h('div', {}, h('b', {}, name), h('label', { class: 'row' }, kind), relief))
      }),
    )
    drawSwatches()
  }
  // ---------------------------------------------------------------- previewing the moon
  const timeIn = h('input', {
    type: 'range',
    min: 0,
    max: 1,
    step: 0.001,
    title: 'where the moon is in its night: rising, across, behind the stone',
  }) as HTMLInputElement
  const timeOut = h('span', { class: 'dim num-out' })
  let dragging = false
  timeIn.addEventListener('pointerdown', () => (dragging = true))
  timeIn.addEventListener('pointerup', () => (dragging = false))
  timeIn.addEventListener('input', () => {
    const { crossing, hidden } = moonTiming()
    moon.set({ t: Number(timeIn.value) * (crossing + hidden) })
  })
  const previewTime = h('label', { class: 'row', title: 'where the moon is in its night' }, h('span', { class: 'dim' }, 'time'), timeIn, timeOut)
  const phaseIn = h('select', { title: 'its phase' }) as HTMLSelectElement
  phaseIn.append(...PHASES.map((_, i) => h('option', { value: i }, PHASE_NAMES[i])))
  phaseIn.addEventListener('change', () => moon.set({ phase: Number(phaseIn.value) }))
  const previewPhase = h('label', { class: 'row' }, h('span', { class: 'dim' }, 'phase'), phaseIn)
  const tick = () => {
    const m = moon.get()
    if (!m || !previewTime.isConnected) return
    const { crossing, hidden } = moonTiming()
    if (!dragging) timeIn.value = String(m.t / (crossing + hidden))
    const up = m.t < crossing
    timeOut.textContent = up ? `${Math.floor(m.t / 60)}:${String(Math.floor(m.t % 60)).padStart(2, '0')}` : 'hidden'
    if (document.activeElement !== phaseIn) phaseIn.value = String(m.phase)
  }

  const render = () => {
    renderList()
    renderFamily()
    tick()
  }
  render()
  return { left, right, refresh: render, tick }
}
