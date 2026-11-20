import { rand } from '../util'
import { GROVE_SPOTS, PROPS, RES, inPool, nearProp, project } from '../world'
import type { Fsm } from './fsm'
import { findPath, nav, walkable } from './nav'
import type { Ctx, Mush, MushState, Stick, Walker, World } from './types'

/** The context the state machines run with: the world, and a way to raise events in it. */
export const ctxFor = (w: World): Ctx => ({
  w,
  emit: (type, ...payload) => w.queue.push({ type, payload: payload[0] } as World['queue'][number]),
})

/** Raining enough to count (creatures shelter, candles go out, the rune wakes). */
export const isRaining = (w: World): boolean => w.weather.rain > 0.3
/** How hard it's raining, 0..1 (drops, the pool, the fire's struggle all follow this). */
export const rainAmount = (w: World): number => w.weather.rain
export const tell = (w: World, line: string) => w.story.push(line)

/**
 * Where in the quiet grove someone comes to rest: near the friends who went before them (the closer
 * the friend, the stronger the pull), and away from those they hardly knew, so the grove keeps the
 * shape of the village's friendships. Null if the grove is full.
 */
export function restingPlace(w: World, m: Mush): number | null {
  const taken = new Set([...w.memorials.map((g) => g.spot), ...w.mush.filter((o) => o.fsm.state === 'wilting' && o.spot !== null).map((o) => o.spot)])
  const free = GROVE_SPOTS.map((_, i) => i).filter((i) => !taken.has(i))
  if (!free.length) return null
  const score = (i: number) => {
    const [x, z] = GROVE_SPOTS[i]
    // friends (closer than 0.25) pull, the rest push a little; both fade with distance
    const pulls = w.memorials.reduce((s, g) => s + ((m.bonds[g.who] ?? 0) - 0.25) / (1 + Math.hypot(g.x - x, g.z - z) / 6), 0)
    return pulls + Math.random() * 0.05 // (and a little chance, between near-equal places)
  }
  return free.map((i) => [i, score(i)] as const).reduce((a, b) => (b[1] > a[1] ? b : a))[0]
}

/** The close friend whose glowcap someone has come to rest beside, if any. */
export const restsBeside = (w: World, m: Mush, x: number, z: number) =>
  w.memorials.find((g) => (m.bonds[g.who] ?? 0) >= 0.5 && Math.hypot(g.x - x, g.z - z) < 7)
export const candlesNeedTending = (w: World): boolean => w.candles.some((c) => !c.lit || c.wax < 0.2)

export const isElder = (m: { age: number; lifespan: number }): boolean => m.age > m.lifespan * 0.75

const NAMES =
  'Morel Puffball Sorrel Bracken Tuft Fen Wick Pip Bram Chanterelle Truffle Lichen Bolete Spore Inkcap Russet Moss Thimble Cobb Fennel Nettle Burr Hazel Oakmoss Bilberry Cap Gill Tansy Woodruff Clover Marrow Brindle Dusk Ember Peat Rook Wren Sedge'.split(
    ' ',
  )
/**
 * A name for someone new: one not given before this night, and once they've all been given, the one
 * given longest ago (never one that's living, or on a glowcap: the story would say "Peat missed Peat").
 */
export function freshName(w: World): string {
  const taken = new Set([...w.mush.map((m) => m.given), ...w.memorials.map((g) => g.name)])
  const unused = NAMES.filter((n) => !w.named.includes(n) && !taken.has(n))
  const name = unused.length ? pick(unused) : (w.named.find((n) => !taken.has(n)) ?? pick(NAMES))
  w.named = [...w.named.filter((n) => n !== name), name]
  return name
}

/** One of these, at random (the story's lines, said a few different ways). */
export const pick = <T>(xs: readonly T[]): T => xs[(Math.random() * xs.length) | 0]

/** The road out: past the lantern and off the left edge. */
export const ROAD: [number, number][] = [
  [-60, 12],
  [-92, 19],
  [-160, 25],
]
/** How far the firelight reaches; follows the fire's heat, not its fuel, so it swells and fades naturally. */
export const lightRadius = (w: World): number => 32 + 78 * w.fire.heat
export const countIn = <S extends string>(list: { fsm: Fsm<S> }[], ...states: S[]): number => list.filter((e) => states.includes(e.fsm.state)).length
export const hutOccupancy = (w: World, hut: number): number => w.mush.filter((m) => m.fsm.state === 'asleep' && m.hut === hut).length
export const isMoving = (e: Walker): boolean => Math.hypot(e.tx - e.x, e.tz - e.z) > 0.6

/** Shroomfolk states where they are walking somewhere (those that sit once there walk first: tend, visit, keep). */
export const WALKING: MushState[] = [
  'arriving',
  'wander',
  'fetch',
  'haul',
  'feed',
  'stoke',
  'toHut',
  'entering',
  'exiting',
  'farewell',
  'departing',
  'wilting',
  'tend',
  'visit',
  'keep',
  'sing',
  'join',
  'offer',
]

/** How long a sung note drifts up before it's gone (s). */
export const NOTE_LIFE = 2.6

/** Is someone stepping through this hut's door right now? */
export const doorOpen = (w: World, hut: number): boolean => w.mush.some((m) => m.hut === hut && (m.fsm.state === 'entering' || m.fsm.state === 'exiting'))

/**
 * Walk toward (tx, tz), around obstacles; returns true on arrival. A path is found whenever the
 * target changes (nav.ts). `direct` walks a straight line instead, for stepping through doorways.
 */
/** Turn to face a point (sprites face right unflipped). */
export function face(e: Walker, x: number) {
  if (Math.abs(x - e.x) > 0.1) e.flip = x < e.x
}

export function moveTo(e: Walker, speed: number, dt: number, direct = false): boolean {
  if (!direct) {
    const key = `${e.tx.toFixed(1)},${e.tz.toFixed(1)},${nav.version}`
    if (e.pathKey !== key || !e.path) {
      e.path = findPath(e.x, e.z, e.tx, e.tz)
      e.pathKey = key
    }
    while (e.path.length && Math.hypot(e.path[0][0] - e.x, e.path[0][1] - e.z) < 0.6) e.path.shift()
    if (!e.path.length) {
      // arrived (or as close as the obstacles allow): settle here
      e.tx = e.x
      e.tz = e.z
      e.pathKey = `${e.tx.toFixed(1)},${e.tz.toFixed(1)},${nav.version}`
      return true
    }
    const [wx, wz] = e.path[0]
    const dx = wx - e.x
    const dz = wz - e.z
    const d = Math.hypot(dx, dz)
    const k = Math.min(d, speed * dt) / d
    e.x += dx * k
    e.z += dz * k
    if (Math.abs(dx) > 0.1) e.flip = dx < 0
    return false
  }
  const dx = e.tx - e.x
  const dz = e.tz - e.z
  const d = Math.hypot(dx, dz)
  if (d < 0.6) return true
  const k = Math.min(d, speed * dt) / d
  e.x += dx * k
  e.z += dz * k
  if (Math.abs(dx) > 0.1) e.flip = dx < 0
  return false
}

/** A random open spot in a ring around the fire, away from water and props. */
export function freeSpotNear(w: World, r0: number, r1: number): [number, number] {
  for (let k = 0; k < 40; k++) {
    const a = Math.random() * Math.PI * 2
    const r = rand(r0, r1)
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r * 0.85
    if (inPool(x, z, w.poolLevel * 1.35) || nearProp(x, z, 9) || !walkable(x, z)) continue
    if (Math.hypot(x - PROPS.knight.x, z - PROPS.knight.z) < 8 || Math.hypot(x - PROPS.woodpile.x, z - PROPS.woodpile.z) < 6) continue
    return [x, z]
  }
  return [r0, 0]
}

/** A stick lying on the ground. */
export const restingStick = (x: number, z: number): Stick => ({
  x,
  z,
  claimed: false,
  y: 0,
  vy: 0,
  angle: Math.random() < 0.5 ? 0 : Math.PI,
  spin: 0,
  landed: true,
  glint: 0,
})

/** Somewhere at the forest edge for a stick to fall. */
export function stickSpot(w: World): Stick {
  for (let k = 0; k < 40; k++) {
    const a = Math.random() * Math.PI * 2
    const r = rand(40, 66)
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r * 0.8
    if (!inPool(x, z, w.poolLevel * 1.3) && z > -48 && Math.abs(x) < 120 && !nearProp(x, z, 10) && walkable(x, z)) return restingStick(x, z)
  }
  return restingStick(-50, 10)
}

export function burst(w: World, n: number, power: number) {
  for (let i = 0; i < n; i++)
    w.embers.push({ ox: rand(-4, 4), oy: 12, vy: rand(14, 30) * power, vx: rand(-8, 8), life: rand(0.8, 2.2), age: 0, ph: rand(0, 6) })
}

/** Where the crow sits: on top of the trigon stone (screen space). */
export function perchPos(): [number, number] {
  const [bx, by, s] = project(PROPS.trigon.x, 0, PROPS.trigon.z)
  return [bx + 2 * RES, by - Math.round(40 * s)]
}
