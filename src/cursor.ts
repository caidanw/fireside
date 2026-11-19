/**
 * The hand cursor: the 'hand' sprite (drawn in the editor, one frame per pose, each with its
 * hotspot) made into a CSS cursor, so the system draws it (no lag) at one CSS pixel per art pixel,
 * crisp on high-density screens too.
 */
import { DATA, SPRITES } from './art'

const cache = new Map<string, { crisp: string; plain: string }>()

/** A frame of the hand as CSS cursor values (crisp on any screen, and plain for browsers without image-set), or null if there's no hand (yet). */
function handCursor(frame: string): { crisp: string; plain: string } | null {
  const hand = SPRITES.hand
  const rows = hand?.frames[frame]
  if (!hand || !rows?.length) return null
  const key = `${frame}|${rows.join('/')}|${DATA.sprites.hand?.hotspots?.[frame]}`
  const hit = cache.get(key)
  if (hit) return hit
  const pal = hand.palettes.default
  const [hx, hy] = DATA.sprites.hand?.hotspots?.[frame] ?? [0, 0] // (the hotspots are in the data; the resolved art doesn't carry them)
  const image = (k: number) => {
    const c = document.createElement('canvas')
    c.width = rows[0].length * k
    c.height = rows.length * k
    const ctx = c.getContext('2d')!
    rows.forEach((row, r) =>
      [...row].forEach((ch, x) => {
        const col = pal[ch]
        if (ch === '.' || !col) return
        ctx.fillStyle = `rgb(${col.map((v) => Math.round(v * 255)).join(' ')})`
        ctx.fillRect(x * k, r * k, k, k)
      }),
    )
    return c.toDataURL()
  }
  const one = image(1)
  const plain = `url("${one}") ${hx} ${hy}, auto`
  const value = { crisp: `image-set(url("${one}") 1x, url("${image(2)}") 2x) ${hx} ${hy}, ${plain}`, plain }
  cache.set(key, value)
  return value
}

/** Point an element's cursor at a frame of the hand (left as it is if there's no hand). */
function useHand(el: HTMLElement, frame: string) {
  const value = handCursor(frame)
  if (!value) return
  // a browser that can't read image-set() ignores the second, keeping the plain image
  el.style.cursor = value.plain
  el.style.cursor = value.crisp
}

/** Make a frame of the hand the page's cursor: the stylesheets read it as var(--hand-point). */
export function handForPage(frame: string) {
  const value = handCursor(frame)
  if (!value) return
  const plain = CSS.supports('cursor', value.crisp) ? value.crisp : value.plain
  document.documentElement.style.setProperty('--hand-point', plain)
}

/** Keep an element's cursor posed as `pose()` says (checked every frame; the cursor changes only when the pose does). */
export function followHand(el: HTMLElement, pose: () => string) {
  let shown = ''
  const show = () => {
    const next = pose()
    if (next !== shown) useHand(el, (shown = next))
    requestAnimationFrame(show)
  }
  requestAnimationFrame(show)
}
