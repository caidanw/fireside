/**
 * The visitor's hand. It can take a log from the woodpile, a burning stick from the fire, a stick
 * (or a burning one) from the ground, the road lantern, or a shroomfolk; carry it; and set it down.
 * Wood let go over the fire feeds it; an unlit stick held over the fire for a moment catches. A
 * burning stick burns down (faster in the rain) and goes out. The lantern hangs back on its post if
 * it's set down by it. A shroomfolk set down drops a little, wobbles, and gets on with things.
 *
 * What the hand is over comes from the renderer (the hover key of whatever is under the pointer).
 */
import { PROPS, fromFire, inPool, project } from '../world'
import { lanternGlass } from './ambient'
import { rand } from '../util'
import { ctxFor, isRaining, tell } from './helpers'
import { transition } from './fsm'
import { mushMachine } from './shroomfolk'
import type { Held, World } from './types'

/** How long a burning stick burns (seconds), and how long to hold a stick in the flames to light it. */
const BURN = 90
const CATCH = 1
/** How close (scene pixels, on screen) to where it hangs a lantern has to be let go to hang back on its post. */
const POST_REACH = 26
/** How fast things let go of fall (as dropped sticks do). */
const GRAVITY = 150
/** States a shroomfolk can't be picked up in (being born, asleep in a hut, leaving, going to the soil, in a song). */
const BUSY = new Set(['sprouting', 'asleep', 'entering', 'exiting', 'arriving', 'departing', 'wilting', 'farewell', 'carried'])

/**
 * Whether something held at (x, height y, z) is over the flames as the visitor sees it: on screen,
 * within the fire's width and between its stones and the tops of its flames. (Held up in the air, the
 * ground under it is well in front of what it looks to be over.)
 */
function overFire(x: number, y: number, z: number): boolean {
  const [sx, sy] = project(x, y, z)
  const [fx, fy, s] = project(0, 0, 0)
  return Math.abs(sx - fx) < 9 * s && sy < fy + s && sy > fy - 18 * s
}
const fed = (w: World, amount: number) => ctxFor(w).emit('fire:fed', { amount })
/** Whether the lantern, let go at (x, height y, z), is by its hook on the post as the visitor sees it (it hangs just below the hand). */
function byHook(x: number, y: number, z: number): boolean {
  const g = lanternGlass()
  const [sx, sy] = project(x, y, z)
  const [px, py] = project(PROPS.lantern.x + g.dx, g.y, PROPS.lantern.z)
  return Math.hypot(sx - px, (sy - py) * 0.8) < POST_REACH
}

/** Fall a tick (height y, speed vy); true on reaching the ground. */
function fall(o: { y: number; vy: number }, dt: number): boolean {
  if (o.y <= 0) return false
  o.vy -= GRAVITY * dt
  o.y = Math.max(0, o.y + o.vy * dt)
  return o.y === 0
}

/** Rings on the pool where something fell in. */
function splash(w: World, x: number, z: number) {
  const [sx, sy] = project(x, 0, z)
  for (let i = 0; i < 3; i++) w.ripples.push({ x: sx + rand(-1.5, 1.5), y: sy + rand(-0.5, 0.5), age: -i * 0.15 })
}

/** Said once a night, the first time the visitor does each thing. */
const once = (w: World, key: string, line: string) => {
  if (w.told.includes(key)) return
  w.told.push(key)
  tell(w, line)
}

/** What the hand would take from the thing under the pointer (by its hover key), if anything. */
export function takeable(w: World, key: string | null): Held | null {
  if (!key) return null
  if (key === 'woodpile') return w.pile > 0 ? { kind: 'log' } : null
  if (key === 'fire') return w.fire.heat > 0.15 ? { kind: 'stick', lit: true, burn: BURN } : null
  if (key === 'lantern') return { kind: 'lantern' }
  const stick = /^stick(\d+)$/.exec(key)
  if (stick) {
    const s = w.sticks[+stick[1]]
    // (even one someone's on their way to fetch: they'll find it gone and get on with something else)
    return s?.landed ? (s.log ? { kind: 'log' } : { kind: 'stick', lit: false, burn: 0 }) : null
  }
  const brand = /^brand(\d+)$/.exec(key)
  if (brand) {
    const b = w.brands[+brand[1]]
    return b ? { kind: 'stick', lit: true, burn: b.burn } : null
  }
  if (key.startsWith('mush')) {
    const m = w.mush.find((m) => `mush${m.id}` === key)
    return m && !BUSY.has(m.fsm.state) && w.keeperId !== m.id ? { kind: 'folk', id: m.id } : null
  }
  return null
}

/** Take hold of the thing under the pointer (returns whether the hand took anything). */
export function grab(w: World, key: string | null, x: number, z: number, y: number): boolean {
  const held = takeable(w, key)
  if (key) ctxFor(w).emit('hand:reach', { key })
  if (key === 'knight' && w.knight.fsm.state !== 'gone') once(w, 'knight', 'A visitor tried to lift the knight. He did not budge, but he seemed to smile.')
  if (!held) return false
  w.hand = { x, z, y, held, catching: 0 }
  if (key === 'woodpile') {
    w.pile--
    once(w, 'log', 'A visitor took a log from the woodpile.')
  } else if (key === 'fire') once(w, 'brand', 'A visitor drew a burning stick from the fire, and carried a little light into the dark.')
  else if (key === 'lantern') {
    w.lantern.onPost = false
    once(w, 'lantern', 'A visitor lifted the lantern down to look around.')
  } else if (key!.startsWith('stick')) w.sticks.splice(+key!.slice(5), 1)
  else if (key!.startsWith('brand')) w.brands.splice(+key!.slice(5), 1)
  else if (held.kind === 'folk') {
    const m = w.mush.find((m) => m.id === held.id)!
    // whatever they were carrying for the fire falls from their hands
    if (m.carrying)
      w.sticks.push({ x: m.x, z: m.z, claimed: false, y: 2, vy: 0, angle: rand(0, Math.PI), spin: rand(-6, 6), landed: false, glint: 0, bundle: m.bundle })
    transition(mushMachine, m, ctxFor(w), 'carried') // (the hand moves them now; their state machine waits)
    m.carrying = false
    m.air = y
    once(w, `folk${m.id}`, `A visitor lifted ${m.name} up off the ground. ${m.name} kicked a little.`)
  }
  return true
}

/** The hand moves (the point on the ground under what it holds, and how high it holds it). */
export function moveHand(w: World, x: number, z: number, y: number) {
  if (!w.hand) w.hand = { x, z, y, held: null, catching: 0 }
  Object.assign(w.hand, { x, z, y })
}

/** The pointer has left the clearing: an empty hand goes with it (a full one keeps hold). */
export function leaveHand(w: World) {
  if (w.hand && !w.hand.held) w.hand = null
}

/** Let go: wood over the fire goes in, the lantern by its post hangs back up, anything else is set down. */
export function release(w: World) {
  const h = w.hand
  const held = h?.held
  if (!h || !held) return
  h.held = null
  const { x, z, y } = h
  if (held.kind === 'log' || held.kind === 'stick') {
    if (overFire(x, y, z)) {
      fed(w, held.kind === 'log' ? 0.2 : 0.1)
      once(w, 'fed', 'A visitor fed the fire, and it roared up gratefully.')
    } else if (held.kind === 'stick' && held.lit) w.brands.push({ x, z, burn: held.burn, y, vy: 0 })
    else w.sticks.push({ x, z, claimed: false, y, vy: 0, angle: rand(0, Math.PI), spin: rand(-6, 6), landed: false, glint: 1, log: held.kind === 'log' })
  } else if (held.kind === 'lantern') {
    w.lantern = byHook(x, y, z) ? { onPost: true, x: PROPS.lantern.x, z: PROPS.lantern.z, y: 0, vy: 0 } : { onPost: false, x, z, y, vy: 0 }
  } else {
    const m = w.mush.find((m) => m.id === held.id)
    if (!m) return
    // not into the fire: set down at the edge of its ring instead
    const r = fromFire(x, z)
    ;[m.x, m.z] = r < 1.15 ? [(x / (r || 1)) * 1.15, (z / (r || 1)) * 1.15] : [x, z]
    m.tx = m.x
    m.tz = m.z
    m.air = y
    transition(mushMachine, m, ctxFor(w), 'dizzy')
  }
}

/** Each tick: burning sticks burn down (in the hand and on the ground), and a stick held in the flames catches. */
export function stepHand(w: World, dt: number) {
  const wet = isRaining(w) ? 3 : 1
  // burning sticks let go of fall, and burn down where they land (in the pool, they're out with a hiss)
  for (const b of w.brands) {
    b.burn -= dt * wet
    if (!fall(b, dt)) continue
    if (inPool(b.x, b.z, w.poolLevel)) {
      splash(w, b.x, b.z)
      b.burn = 0
    } else for (let i = 0; i < 3; i++) w.puffs.push({ x: b.x, z: b.z, age: -i * 0.04, seed: Math.random() * 100 })
  }
  w.brands = w.brands.filter((b) => b.burn > 0)
  // the lantern set down falls to the ground (into the pool: someone fishes it out and hangs it back up)
  const L = w.lantern
  if (!L.onPost && w.hand?.held?.kind !== 'lantern' && fall(L, dt)) {
    if (inPool(L.x, L.z, w.poolLevel)) {
      splash(w, L.x, L.z)
      Object.assign(L, { onPost: true, x: PROPS.lantern.x, z: PROPS.lantern.z, y: 0, vy: 0 })
      once(w, 'lantern:pool', 'The lantern fell in the pool. Someone fished it out, dried it, and hung it back on its post.')
    } else for (let i = 0; i < 4; i++) w.puffs.push({ x: L.x, z: L.z, age: -i * 0.04, seed: Math.random() * 100 })
  }
  const h = w.hand
  const held = h?.held
  if (!h || !held) return
  if (held.kind === 'stick') {
    if (held.lit) {
      held.burn -= dt * wet
      if (held.burn <= 0) held.lit = false // it goes out, and you're holding a charred stick
    } else if (overFire(h.x, h.y, h.z) && w.fire.heat > 0.15) {
      h.catching += dt
      if (h.catching >= CATCH) {
        held.lit = true
        held.burn = BURN
        h.catching = 0
        once(w, 'lit', 'A visitor held a stick to the flames until it caught.')
      }
    } else h.catching = 0
  }
  // a carried shroomfolk goes where the hand goes
  if (held.kind === 'folk') {
    const m = w.mush.find((m) => m.id === held.id)
    if (!m) h.held = null
    else {
      m.x = m.tx = h.x
      m.z = m.tz = h.z
      m.air = h.y
    }
  }
}
