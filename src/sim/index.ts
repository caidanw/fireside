/**
 * The sim loop: tick every agent's state machine, run the ambient systems,
 * then deliver this tick's events to every agent.
 *
 * To add an entity: give it an `fsm`, write a `Def` for it, and register it in
 * `agents()`. To add an interaction: add an event to `SimEvents`, emit it
 * from one machine, handle it in another.
 */
import { PHASES, moonTiming } from '../moon'
import { rand } from '../util'
import { H, HORIZON, PROPS, RES, W } from '../world'
import { stepAmbient } from './ambient'
import { createCrow, createFrog, crowMachine, frogMachine } from './critters'
import { createDeer, deerMachine } from './deer'
import { createFire, fireMachine } from './fire'
import { send, tick, type Fsm, type MachineDef } from './fsm'
import { stepHand } from './hand'
import { FIRST_DRY, planOpening, stepOpening } from './opening'
import { ctxFor, freeSpotNear, pick, stickSpot, tell } from './helpers'
import { createKnight, knightMachine } from './knight'
import { nav } from './nav'
import { createMush, MAX_VILLAGE, mushMachine, welcomeTraveler } from './shroomfolk'
import type { Ctx, SimEvents, World } from './types'
import { createWeather, weatherMachine } from './weather'

export { grab, leaveHand, moveHand, release, takeable } from './hand'
export { NOTE_LIFE, WALKING, doorOpen, hutOccupancy, isElder, isMoving, isRaining, lightRadius, perchPos, rainAmount } from './helpers'
export * from './types'
export { startSong } from './shroomfolk'

type Agent = [MachineDef<any, Ctx, string, SimEvents>, { fsm: Fsm<string> }]

/** Every entity with a state machine, in update order. */
function agents(w: World): Agent[] {
  return [
    [weatherMachine, w.weather],
    [fireMachine, w.fire],
    [knightMachine, w.knight],
    [deerMachine, w.deer],
    [frogMachine, w.frog],
    [crowMachine, w.crow],
    ...w.mush.map((m): Agent => [mushMachine, m]),
  ]
}

export function createWorld(): World {
  const w: World = {
    t: 0,
    pile: 2,
    poolLevel: 1,
    rune: 0,
    weather: createWeather(),
    fire: createFire(),
    knight: createKnight(),
    deer: createDeer(),
    frog: createFrog(),
    crow: createCrow(),
    mush: [],
    sticks: [],
    tossed: [],
    hand: null,
    told: [],
    nextId: 1,
    named: [],
    opening: planOpening(),
    lantern: { onPost: true, x: PROPS.lantern.x, z: PROPS.lantern.z, y: 0, vy: 0 },
    brands: [],
    stickTimer: 3,
    memorials: [],
    candles: PROPS.graves.map(() => ({ wax: rand(0.5, 1), lit: true })),
    keeperId: null,
    arrivalTimer: 90,
    story: [],
    embers: [],
    drops: Array.from({ length: 220 }, () => ({ x: Math.random() * W, y: Math.random() * H, v: rand(170, 240) * RES, stop: rand(HORIZON, H) })),
    ripples: [],
    zs: [],
    song: null,
    notes: [],
    puffs: [],
    flies: Array.from({ length: 12 }, (_, i) => ({ seed: i * 13.7, x: 0, y: 0, z: 0, a: 0 })),
    flyDip: null,
    nextDip: rand(40, 90),
    shooting: null,
    nextShoot: 20,
    // partway up already, in a phase of its own
    moon: { t: rand(0.2, 0.45) * moonTiming().crossing, phase: Math.floor(rand(0, PHASES.length)) },
    bats: [],
    nextBats: rand(15, 40),
    moths: Array.from({ length: 9 }, (_, i) => ({ seed: i * 7.31, at: i < 6 ? 'fire' : 'lantern', x: 0, y: 0, z: 0 })),
    farFlies: Array.from({ length: 18 }, (_, i) => {
      const swarm = [
        [-110, -70],
        [70, -80],
        [130, -55],
      ][i % 3]
      return { seed: i * 3.17, cx: swarm[0], cz: swarm[1], x: 0, y: 0, z: 0, a: 0 }
    }),
    owl: { blink: 2, away: 0 },
    farDeer: null,
    nextFarDeer: rand(40, 90),
    queue: [],
  }
  w.weather.timer = FIRST_DRY() // the first rain after the opening's visit and song
  for (let i = 0; i < 3; i++) w.sticks.push(stickSpot(w))
  // a village of five, at different points in their lives (one old one near the end of theirs: they
  // go to the grove in the first minute or two), who have known each other a while
  const start: [number, number][] = [
    [-26, -10],
    [20, -14],
    [-6, 16],
    [30, 6],
    [-40, -20],
  ]
  const ages = [0.1, 0.3, 0.55, 0.8].sort(() => Math.random() - 0.5)
  start.forEach(([x, z], i) => w.mush.push(createMush(w, x, z, { home: i % 2, aged: i === 0 ? 0 : ages[i - 1] })))
  const old = w.mush[0]
  old.age = old.lifespan - rand(20, 50)
  old.fate = 'wilting'
  for (const a of w.mush) for (const b of w.mush) if (a !== b && a.id < b.id) a.bonds[b.id] = b.bonds[a.id] = rand(0.2, 0.7)
  // ...and someone who was close to them
  const friend = w.mush[1 + ((Math.random() * 4) | 0)]
  old.bonds[friend.id] = friend.bonds[old.id] = 0.95
  // how the story begins (in the same voice as everything that happens after)
  tell(w, 'Deep in the dark forest, a small village kept a fire burning against the night.')
  tell(w, 'Beside it sat the last knight, keeping his long vigil.')
  tell(w, 'In the quiet grove beyond, candles burned for those who came before.')
  return w
}

/**
 * Advance the world by dt seconds. `isOpenWater(sx, sy)` reports whether a
 * screen pixel is visible pool surface (so raindrops know where to ripple).
 */
export function step(w: World, dt: number, isOpenWater: (sx: number, sy: number) => boolean) {
  const ctx = ctxFor(w)
  w.t += dt
  // keep the walking grid current: the pool's level (paths are re-found when it moves) and the seated knight
  if (Math.abs(nav.level - w.poolLevel) > 0.03) {
    nav.level = w.poolLevel
    nav.version++
  }
  const seated = w.knight.fsm.state === 'resting' || w.knight.fsm.state === 'nodding' || w.knight.fsm.state === 'tending'
  nav.knight = seated ? { x: w.knight.x, z: w.knight.z } : null
  if (w.hand) ctx.emit('hand', { x: w.hand.x, z: w.hand.z })

  for (const [def, e] of agents(w)) tick(def, e, ctx, dt)
  stepOpening(w)
  stepHand(w, dt)
  stepAmbient(w, dt, isOpenWater)
  if (w.queue.length) dispatch(w, ctx)
  w.mush = w.mush.filter((m) => !m.gone)
  welcomeTravelers(w, dt)
  chooseKeeper(w)
}

/** Once the knight has gone to rest, the oldest of the village takes his place by the fire. */
function chooseKeeper(w: World) {
  if (w.knight.fsm.state !== 'gone') return
  if (w.keeperId !== null && w.mush.some((m) => m.id === w.keeperId)) return
  const ending = ['farewell', 'departing', 'wilting']
  const candidates = w.mush.filter((m) => m.size >= 1 && !ending.includes(m.fsm.state))
  if (!candidates.length) return
  const keeper = candidates.reduce((a, b) => (a.age > b.age ? a : b))
  const first = w.keeperId === null
  w.keeperId = keeper.id
  // the keeper tends the fire faithfully, and likes it steady; the village gathers to mark it
  keeper.diligence = Math.max(keeper.diligence, 0.95)
  keeper.likes = 0.8
  for (const m of w.mush) m.merry = Math.min(1, m.merry + 0.5)
  tell(
    w,
    first
      ? `${keeper.name} took up the knight's place by the fire. From then on, the village called them the keeper.`
      : `${keeper.name} became the keeper of the fire.`,
  )
}

/** When the village gets small, now and then someone new comes up the road. */
function welcomeTravelers(w: World, dt: number) {
  if (w.mush.length >= 4 || (w.arrivalTimer -= dt) > 0) return
  w.arrivalTimer = rand(60, 120)
  welcomeTraveler(w)
}

/** Deliver queued events to every agent. Events raised while handling are delivered in the next round. */
function dispatch(w: World, ctx: Ctx) {
  for (let round = 0; round < 4 && w.queue.length; round++) {
    const events = w.queue
    w.queue = []
    for (const ev of events) {
      if (ev.type === 'rain:end') sproutAfterRain(w)
      if (ev.type === 'rain:start') snuffCandles(w)
      for (const [def, e] of agents(w)) send(def, e, ctx, ev.type, ev.payload)
    }
  }
}

/** World-level reaction: rain puts out the grove candles (someone relights them after). */
function snuffCandles(w: World) {
  if (!w.candles.some((c) => c.lit)) return
  for (const c of w.candles) c.lit = false
  if (Math.random() < 0.25) tell(w, pick(['The rain put out the candles in the quiet grove.', "The rain hissed on the grove's candles until they went out."]))
}

/** World-level reaction: every shower leaves a new sprout behind. */
function sproutAfterRain(w: World) {
  if (w.mush.length >= MAX_VILLAGE) return
  const [x, z] = freeSpotNear(w, 30, 44)
  const m = createMush(w, x, z, { size: 0.1 })
  w.mush.push(m)
  tell(
    w,
    pick([
      `A sprout pushed up through the wet earth after the rain. The village named them ${m.name}.`,
      `The rain left a sprout behind, small and damp. The village called them ${m.name}.`,
      `Something new had come up in the wet moss: a sprout. The village named them ${m.name}.`,
      `${m.name} pushed up out of the wet earth, the newest of the village.`,
    ]),
  )
}

// ---------- input from the page ----------
export function toggleRain(w: World) {
  ctxFor(w).emit('weather:toggle')
}
