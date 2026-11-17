/**
 * The last knight keeps a vigil by the fire for the three companions who lie
 * in the quiet grove. He nods off when the fire burns low, and feeding it
 * wakes him.
 *
 * The long arc: after a long vigil (vigilLength), on a dry night with the fire
 * burning well, he rises, takes up his sword, walks to the grove, kneels, and
 * lays his sword beside theirs. Then he rests with them. The village chooses a
 * keeper to sit in his place (see sim/index.ts).
 *
 *   resting <-> nodding
 *   resting, nodding -> tending -> resting   (the fire burning down, a log in the pile: he reaches, lifts, throws)
 *   resting -> rising -> walking -> kneeling -> gone   (switched off for now: LAST_WALK)
 */
import { KNIGHT_GRAVE, PROPS } from '../world'
import { rand } from '../util'
import { fsm } from './fsm'
import { face, isRaining, moveTo, tell } from './helpers'
import type { Def, Knight, KnightState, World } from './types'

export const createKnight = (): Knight => ({
  ...PROPS.knight,
  tx: PROPS.knight.x,
  tz: PROPS.knight.z,
  flip: false,
  home: { ...PROPS.knight },
  fsm: fsm<KnightState>('resting'),
  headDown: false,
  vigil: 0,
  vigilLength: rand(4, 8) * 60, // most visitors watch for a few minutes; the end of his story should be there to find
  route: [],
  sword: 'planted',
  step: 0,
  tend: rand(20, 40),
})

/** Whether he ever ends his vigil and walks to the grove. Off for now: he sits by the fire for good. */
export const LAST_WALK = false

/** The long vigil is over, and tonight is a good night for it. */
const ready = (e: Knight, w: World) => LAST_WALK && e.vigil >= e.vigilLength && !isRaining(w) && w.fire.fsm.state !== 'low'

/** When he tends the fire (seconds into it): he takes a log from the pile, then throws it; then he's done. */
export const TOSS = { take: 0.55, throw: 1.3, done: 1.9 }
const { take: TAKE, throw: THROW, done: DONE } = TOSS
/** Where the log leaves his hand, from where he sits (world units: across, up, toward us), and how long it flies. */
const HAND: [number, number, number] = [-1.1, 9.8, 0.3]
const FLIGHT = 0.95
const GRAVITY = 30
/** Where it lands: on the fire, a little to his side of the middle. */
const ON_FIRE: [number, number] = [2.5, -1]

/** The fire has burned low (he nods off). */
const dim = (w: World) => w.fire.fsm.state === 'low' || w.fire.fsm.state === 'embers'

export const knightMachine: Def<Knight, KnightState> = {
  name: 'knight',
  always: (e, ctx, dt) => {
    // the logs he's thrown, on their way; each feeds the fire where it lands
    const w = ctx.w
    for (const l of w.tossed) {
      l.x += l.vx * dt
      l.z += l.vz * dt
      l.y += l.vy * dt
      l.vy -= GRAVITY * dt
      l.angle += l.spin * dt
    }
    const landed = w.tossed.filter((l) => l.y <= 0.5)
    if (landed.length) {
      w.tossed = w.tossed.filter((l) => l.y > 0.5)
      for (let i = 0; i < landed.length; i++) ctx.emit('fire:fed', { amount: 0.2 })
    }
    if (e.fsm.state !== 'resting' && e.fsm.state !== 'nodding') return
    e.vigil += dt
    // he keeps the fire, quietly: when it burns low (under 30%) and there's wood, he reaches over for a log and throws it on
    if ((e.tend -= dt) <= 0 && w.fire.fuel < 0.3 && w.pile > 0) return 'tending'
  },
  states: {
    resting: {
      enter: (e) => (e.headDown = false),
      update: (e, ctx) => {
        if (ready(e, ctx.w)) return 'rising'
        return dim(ctx.w) && e.fsm.time > 3 ? 'nodding' : undefined
      },
    },
    nodding: {
      update: (e, ctx) => {
        e.headDown = Math.sin(e.fsm.time * 0.7) > -0.3
        return !dim(ctx.w) ? 'resting' : undefined
      },
      on: { 'fire:fed': () => 'resting' },
    },
    tending: {
      enter: (e) => (e.headDown = false),
      update: (e, ctx, dt) => {
        const w = ctx.w
        const at = (s: number) => e.fsm.time >= s && e.fsm.time - dt < s
        if (at(TAKE)) {
          if (w.pile <= 0) return 'resting' // someone took the last one
          w.pile--
        }
        if (at(THROW)) {
          const [hx, hy, hz] = HAND
          const x = e.x + hx
          const z = e.z + hz
          const [tx, tz] = ON_FIRE
          w.tossed.push({
            x,
            z,
            y: hy,
            vx: (tx - x) / FLIGHT,
            vz: (tz - z) / FLIGHT,
            vy: (0.5 - hy + 0.5 * GRAVITY * FLIGHT * FLIGHT) / FLIGHT,
            angle: 0,
            spin: rand(-9, -6),
          })
          if (Math.random() < 0.25) tell(w, 'The knight reached for a log and tossed it on the fire.')
        }
        return e.fsm.time >= DONE ? 'resting' : undefined
      },
      exit: (e) => (e.tend = rand(25, 50)),
    },
    rising: {
      enter: (e, ctx) => {
        e.sword = 'carried'
        tell(ctx.w, 'After a long vigil, the last knight rose from the fire and took up his sword.')
      },
      update: (e) => (e.fsm.time > 2.5 ? 'walking' : undefined),
    },
    walking: {
      // around the fire and the pool, to the quiet grove
      enter: (e) => {
        e.route = [
          [-12, 14],
          [28, 15],
          [56, -4],
          [KNIGHT_GRAVE.x - 3, KNIGHT_GRAVE.z + 2],
        ]
        ;[e.tx, e.tz] = e.route[0]
      },
      update: (e, _ctx, dt) => {
        e.step += dt
        if (!moveTo(e, 3, dt)) return
        e.route.shift()
        if (!e.route.length) return 'kneeling'
        ;[e.tx, e.tz] = e.route[0]
      },
    },
    kneeling: {
      enter: (e) => face(e, KNIGHT_GRAVE.x),
      update: (e, ctx) => {
        if (e.fsm.time < 5) return
        e.sword = 'laid'
        tell(ctx.w, 'He laid his sword beside theirs, and rested at last. Four went on.')
        return 'gone'
      },
    },
    gone: {},
  },
}
