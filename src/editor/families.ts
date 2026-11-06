/**
 * The families view: the things the renderer generates rather than draws from art (trees,
 * bushes, rocks, stones), tuned family by family against the live scene. For now each family's
 * surfaces: which texture they have and how strongly it bumps the light. Edits data/families.json,
 * live and staged.
 */
import { DATA, changed, type DataFile, type Highlights, type Surface } from '../art'
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
}

export interface FamiliesEditor {
  /** The list of families (left). */
  left: HTMLElement
  /** The chosen family's settings (right). */
  right: HTMLElement
  refresh(): void
}

export function createFamiliesEditor(edited: (file: DataFile) => void): FamiliesEditor {
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
    const slider = (label: string, title: string, get: () => number, set: (v: number) => void, max = 1) => {
      const value = h('span', { class: 'dim num-out' }, get().toFixed(2))
      const input = h('input', { type: 'range', min: 0, max, step: 0.05, value: get(), title }) as HTMLInputElement
      input.addEventListener('input', () => {
        set(Number(input.value))
        value.textContent = get().toFixed(2)
        touch(false)
      })
      input.addEventListener('change', () => touch(true))
      return h('label', { class: 'row', title }, h('span', { class: 'dim' }, label), input, value)
    }
    const hl = fam.highlights
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
  const render = () => {
    renderList()
    renderFamily()
  }
  render()
  return { left, right, refresh: render }
}
