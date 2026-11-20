/**
 * Shroomfolk. Needs: warmth (stay near the fire) and energy (rest in a hut).
 * Jobs: keep the fire fed, keep the woodpile stocked, keep the grove candles
 * lit. They age, and every life ends one of two ways, both told in the story
 * feed. The quiet grove is where the knight's companions lie; the shroomfolk
 * learned from him to honour the dead there.
 *
 *   sprouting | arriving -> idle
 *   idle -> feed -> stoke -> idle                          (fire low, logs in the pile)
 *   idle -> toHut -> entering -> asleep -> exiting -> idle (tired, and there's room)
 *   idle -> fetch -> haul -> idle                          (pile running short, a stick lying about)
 *   idle -> wander -> idle                                 (otherwise)
 *   idle -> farewell -> departing -> (gone)                (old: a last moment by the knight, then the road)
 *   idle -> wilting -> (gone, leaves a glowcap)            (old: back to the soil in the quiet grove)
 *   idle -> tend -> idle                                   (the grove candles are out or burning low)
 *   idle -> visit -> idle                                  (now and then, sit by a friend's glowcap)
 *   idle -> keep -> idle                                   (the keeper, once the knight has gone)
 *   idle -> sing -> idle                                   (now and then, with others gathered by the fire)
 *   (free) -> join -> offer -> dance -> idle               (a song started: bring a piece of wood, throw it
 *                                                           on, dance round the fire until the song ends)
 *
 * Tending the fire is attention, not an alarm: each notices for themselves when the fire is
 * smaller than they'd like (if they're awake, close and not busy), sooner the more diligent
 * they are. What size they'd like depends on who they are (likes, hardy), how cold they are,
 * and how merry: a festive mood spreads between those gathered by the fire, and merry
 * shroomfolk feed it again and again until it blazes. When the pile runs low, someone goes
 * to the forest's edge for wood.
 *
 * Reacts to: stick:landed (someone go get it), rain:start (wake up and come out, they love
 * the rain), rain:end (merry, if they're by the fire).
 */
import { clamp, rand } from '../util'
import { GROVE, GROVE_SPOTS, HUT, inPool, PROPS } from '../world'
import { fsm, transition } from './fsm'
import {
  candlesNeedTending,
  countIn,
  ctxFor,
  face,
  freeSpotNear,
  freshName,
  isElder,
  isRaining,
  lightRadius,
  moveTo,
  pick,
  restingPlace,
  restingStick,
  restsBeside,
  ROAD,
  tell,
} from './helpers'
import type { Ctx, Def, Mush, MushState, Stick, World } from './types'

export interface MushOptions {
  size?: number
  home?: number
  /** Fraction of the lifespan already lived. */
  aged?: number
  state?: MushState
}

export function createMush(w: World, x: number, z: number, o: MushOptions = {}): Mush {
  const size = o.size ?? 1
  const lifespan = rand(60 * 60, 90 * 60) // long enough to get to know them: someone leaves or dies every 10-15 minutes
  return {
    fsm: fsm<MushState>(o.state ?? (size < 1 ? 'sprouting' : 'idle')),
    id: w.nextId++,
    seed: Math.random(),
    name: freshName(w),
    age: (o.aged ?? 0) * lifespan,
    lifespan,
    route: [],
    sink: 0,
    gone: false,
    spot: null,
    bonds: {},
    grief: {},
    x,
    z,
    tx: x,
    tz: z,
    flip: false,
    wait: rand(0, 2),
    warmth: 0.8,
    energy: rand(0.45, 1),
    diligence: rand(0.15, 1),
    hardy: rand(0, 1),
    likes: rand(0.25, 0.9),
    merry: 0,
    ring: 0,
    home: o.home ?? (Math.random() * PROPS.huts.length) | 0,
    size,
    carrying: false,
    claim: null,
    hut: null,
  }
}

/** A traveler walks up the road from off-screen and joins the village. */
export function createTraveler(w: World): Mush {
  const [sx, sz] = ROAD[ROAD.length - 1]
  const m = createMush(w, sx, sz, { aged: rand(0.1, 0.4), state: 'arriving' })
  m.route = [...ROAD]
    .reverse()
    .slice(1)
    .concat([freeSpotNear(w, 16, 30)])
  ;[m.tx, m.tz] = m.route[0]
  return m
}

const PILE_SPOT = [PROPS.woodpile.x - 3, PROPS.woodpile.z + 3] as const
const MAX_FETCHERS = 3
const WORKING: MushState[] = ['fetch', 'haul', 'feed', 'stoke', 'join', 'offer']
const doorX = (hut: number) => PROPS.huts[hut].x + HUT.doorDx

/** A hut with a free bed (counting those already on their way), preferring home. */
function hutWithRoom(m: Mush, ctx: Ctx): number | null {
  const taken = (i: number) => ctx.w.mush.filter((o) => o !== m && o.hut === i).length
  const order = [m.home, ...PROPS.huts.map((_, i) => i).filter((i) => i !== m.home)]
  return order.find((i) => taken(i) < HUT.capacity) ?? null
}

const adult = (m: Mush) => m.size >= 1
const fetchers = (ctx: Ctx) => countIn(ctx.w.mush, 'fetch', 'haul')

const feeders = (ctx: Ctx) => countIn(ctx.w.mush, 'feed', 'stoke')

/** States in which they'd notice the fire (awake, not busy with a job). */
const ATTENTIVE: MushState[] = ['idle', 'wander', 'keep', 'visit']

/** Free to drop what they're doing for a song (awake, and not in the middle of a job). */
export const JOINABLE: MushState[] = ['idle', 'wander', 'keep', 'visit']
/** The singer's place and the dancers' ring, round the fire (further back from a blaze), as x and z radii. */
const songRing = (w: World) => 13 + Math.max(0, w.fire.heat - 0.6) * 12
const danceRing = (w: World) => 17 + Math.max(0, w.fire.heat - 0.6) * 14
const RING_Z = 0.7
/** Seconds near each other for two shroomfolk to become as close as can be. */
const BONDING = 15 * 60
/** Seconds for a closest friend's loss to come back to be missed again (a loose acquaintance's takes longer, by how loose). */
const GRIEVING = 4 * 60
/** Seconds for grief to come back half as fast (it eases with time). */
const HEALING = 20 * 60

const SONG_ENDS = ['The song ended, and the fire crackled on.', 'The last notes drifted up with the sparks.']

/** The fire they'd like right now: their taste, more when cold (unless hardy) or in the rain, much more when merry. */
const fireWanted = (m: Mush, w: World) => Math.min(1.25, m.likes + (1 - m.warmth) * (1 - m.hardy) * 0.35 + (isRaining(w) ? 0.12 : 0) + m.merry * 0.75)

/** Would they go and feed the fire? (Close enough to see it, wood in the pile, not too many already at it.) */
const wantsToFeed = (m: Mush, ctx: Ctx) => {
  const w = ctx.w
  if (!adult(m) || w.pile <= 0 || feeders(ctx) >= (m.merry > 0.4 ? 2 : 1)) return false
  if (Math.hypot(m.x, m.z) > 26 + 18 * w.fire.heat) return false // only those near enough to see it's dwindling
  return w.fire.fuel < fireWanted(m, w) - 0.08
}

/** How likely (per second) they are to notice: the diligent sooner, and the further the fire is from what they'd like. */
const urge = (m: Mush, ctx: Ctx) =>
  (0.005 + 0.2 * m.diligence + 0.4 * m.merry) * (m.warmth > 0.7 && m.merry < 0.2 ? 0.5 : 1) * clamp((fireWanted(m, ctx.w) - ctx.w.fire.fuel) / 0.4) // warm and content: in no hurry

/** Somewhere at the forest's edge to look for wood. */
function forestEdge(w: World): [number, number] {
  for (let k = 0; k < 20; k++) {
    const a = Math.random() * Math.PI * 2
    const x = Math.cos(a) * rand(62, 85) * 1.2
    const z = Math.sin(a) * rand(45, 60) - 10
    if (z < 30 && !inPool(x, z, w.poolLevel * 1.3)) return [x, z]
  }
  return [-60, -30]
}

function claim(m: Mush, s: Stick): MushState {
  s.claimed = true
  m.claim = s
  return 'fetch'
}

/** Walk a route; true once the last waypoint is reached. */
function followRoute(m: Mush, speed: number, dt: number): boolean {
  if (!moveTo(m, speed, dt)) return false
  m.route.shift()
  if (!m.route.length) return true
  ;[m.tx, m.tz] = m.route[0]
  return false
}

const pace = (m: Mush) => (isElder(m) ? 0.7 : 1)

/** What to do next, in priority order. */
function decide(m: Mush, ctx: Ctx): MushState {
  const w = ctx.w
  // the end of a life: half set off down the road, half go back to the soil
  if (m.age > m.lifespan) return m.fate ?? (Math.random() < 0.5 ? 'farewell' : 'wilting')
  // missing a friend who's gone, enough: before anything else, go and sit a while by their glowcap
  // (likelier the more they miss them)
  const missed = w.memorials.map((g, i) => [i, m.grief[g.who] ?? 0] as const).filter(([, g]) => g >= 1)
  if (adult(m) && missed.length && !isRaining(w)) {
    const [spot, grief] = missed.reduce((a, b) => (a[1] >= b[1] ? a : b))
    if (Math.random() < 0.5 + (grief - 1) * 2) {
      m.spot = spot
      return 'visit'
    }
  }
  // a song is going: those who were busy when it started come along once they're free
  if (w.song && w.song.singer !== m.id && adult(m) && Math.hypot(m.x, m.z) < 70) return 'join'
  if (wantsToFeed(m, ctx) && Math.random() < 0.3 + m.diligence + m.merry) return 'feed'
  // tired: go home to rest (in the rain they'd rather stay out, unless exhausted)
  if (adult(m) && m.energy < 0.3 && (!isRaining(w) || m.energy < 0.1)) {
    const hut = hutWithRoom(m, ctx)
    if (hut !== null) {
      m.hut = hut
      return 'toHut'
    }
  }
  // the grove candles: someone goes to relight them once the rain has passed
  if (adult(m) && !isRaining(w) && candlesNeedTending(w) && countIn(w.mush, 'tend') === 0) return 'tend'
  const free = w.sticks.filter((s) => !s.claimed && s.landed)
  if (adult(m) && w.pile < 5 && free.length && fetchers(ctx) < MAX_FETCHERS) {
    const nearest = free.reduce((a, b) => (Math.hypot(a.x - m.x, a.z - m.z) < Math.hypot(b.x - m.x, b.z - m.z) ? a : b))
    return claim(m, nearest)
  }
  // the pile is running low and nothing's lying about: go to the forest's edge for wood
  if (adult(m) && w.pile < 6 && !free.length && fetchers(ctx) < MAX_FETCHERS && Math.random() < 0.15 + 0.45 * m.diligence + 0.3 * m.merry) {
    const s = { ...restingStick(...forestEdge(w)), bundle: true }
    w.sticks.push(s)
    return claim(m, s)
  }
  // the keeper sits in the knight's place by the fire
  if (w.keeperId === m.id && Math.random() < 0.6) return 'keep'
  return 'wander'
}

/** They start a song (they go on to 'sing'): the others hear it and come. */
export function beginSong(m: Mush, ctx: Ctx) {
  m.merry = Math.min(1, m.merry + 0.6)
  ctx.w.song = { singer: m.id, until: Infinity }
  ctx.emit('song:start')
}

const answerStick = (m: Mush, ctx: Ctx, s: Stick) => (adult(m) && !s.claimed && ctx.w.pile < 9 && fetchers(ctx) < MAX_FETCHERS ? claim(m, s) : undefined)

export const mushMachine: Def<Mush, MushState> = {
  name: 'shroomfolk',
  always: (m, ctx, dt) => {
    const w = ctx.w
    // friends are made by time spent near each other (by the fire, dancing, at home)...
    if (m.fsm.state !== 'carried')
      for (const o of w.mush) if (o !== m && Math.hypot(o.x - m.x, o.z - m.z) < 12) m.bonds[o.id] = Math.min(1, (m.bonds[o.id] ?? 0) + dt / BONDING)
    // ...and missed when they're gone, more and sooner the closer they were, and less as time passes
    // (it dims their mood)
    for (const g of w.memorials) {
      const bond = m.bonds[g.who] ?? 0
      const healing = 0.5 ** ((w.t - g.at) / HEALING)
      if (bond > 0) m.grief[g.who] = Math.min(1.5, (m.grief[g.who] ?? 0) + (dt * bond * healing) / GRIEVING)
    }
    if (Object.values(m.grief).some((v) => v >= 1)) m.merry = Math.max(0, m.merry - dt / 200)
    const d = Math.hypot(m.x, m.z)
    const near = d < lightRadius(w) * 0.55
    m.warmth = clamp(m.warmth + dt * (near ? 0.08 : -0.05) * (isRaining(w) ? 0.6 : 1))
    if (m.fsm.state === 'asleep')
      m.energy = clamp(m.energy + dt / 28) // a proper sleep: often several are asleep at once, and the fire is left alone
    else if (adult(m)) m.energy = clamp(m.energy - dt / (WORKING.includes(m.fsm.state) ? 60 : 100))
    m.age += dt
    // a festive mood fades slowly, and spreads between those gathered by the fire
    m.merry = Math.max(0, m.merry - dt / 110)
    if (d < 34 && m.fsm.state !== 'asleep') {
      // it passes on weaker than it is (catching up toward 80% of the merriest nearby), so it fades unless renewed
      let around = 0
      let merriest = 0
      for (const o of w.mush) {
        if (o === m || o.fsm.state === 'asleep' || Math.hypot(o.x - m.x, o.z - m.z) > 14) continue
        around++
        merriest = Math.max(merriest, o.merry)
      }
      if (merriest * 0.8 > m.merry) m.merry += (merriest * 0.8 - m.merry) * dt * 0.25
      // now and then, with enough of them gathered, someone starts a song, and the others come
      if (around >= 2 && !w.song && adult(m) && JOINABLE.includes(m.fsm.state) && Math.random() < dt / 500) {
        beginSong(m, ctx)
        return 'sing'
      }
    }
    // noticing the fire: awake, not busy, close enough, and it's smaller than they'd like
    if (ATTENTIVE.includes(m.fsm.state) && m.fsm.time > 1 && wantsToFeed(m, ctx) && Math.random() < dt * urge(m, ctx)) return 'feed'
  },
  states: {
    sprouting: {
      update: (m, _ctx, dt) => ((m.size = Math.min(1, m.size + dt / 25)) >= 1 ? 'idle' : undefined),
    },
    arriving: {
      update: (m, _ctx, dt) => (followRoute(m, 5, dt) ? 'idle' : undefined),
    },
    idle: {
      enter: (m) => (m.wait = rand(0.5, 3)),
      update: (m, ctx, dt) => ((m.wait -= dt) <= 0 ? decide(m, ctx) : undefined),
      on: { 'stick:landed': answerStick },
    },
    wander: {
      enter: (m, ctx) => {
        const range = m.warmth < 0.35 ? 26 : isRaining(ctx.w) ? 70 : 40 // cold ones stay close
        const back = 16 + Math.max(0, ctx.w.fire.heat - 0.7) * 16 // and everyone sits further back from a blaze
        ;[m.tx, m.tz] = freeSpotNear(ctx.w, back, Math.max(back + 8, range))
      },
      update: (m, ctx, dt) => (moveTo(m, (isRaining(ctx.w) ? 7 : 5) * pace(m), dt) ? 'idle' : undefined),
      on: { 'stick:landed': answerStick },
    },
    fetch: {
      enter: (m) => {
        m.tx = m.claim!.x
        m.tz = m.claim!.z
      },
      update: (m, ctx, dt) => {
        const s = m.claim
        if (!s || !ctx.w.sticks.includes(s)) return 'idle'
        if (!moveTo(m, 9, dt)) return
        ctx.w.sticks.splice(ctx.w.sticks.indexOf(s), 1)
        m.bundle = !!s.bundle
        return 'haul'
      },
      exit: (m) => {
        if (m.claim) m.claim.claimed = false
        m.claim = null
      },
    },
    haul: {
      enter: (m) => {
        m.carrying = true
        ;[m.tx, m.tz] = PILE_SPOT
      },
      update: (m, ctx, dt) => {
        if (!moveTo(m, 7, dt)) return
        ctx.w.pile = Math.min(9, ctx.w.pile + (m.bundle ? 2 : 1))
        return 'idle'
      },
      exit: (m) => (m.carrying = false),
    },
    feed: {
      enter: (m) => ([m.tx, m.tz] = PILE_SPOT),
      update: (m, ctx, dt) => {
        if (!moveTo(m, 7, dt)) return
        if (ctx.w.pile <= 0) return 'idle'
        ctx.w.pile--
        return 'stoke'
      },
    },
    stoke: {
      enter: (m) => {
        m.carrying = true
        m.tx = 6
        m.tz = 4
      },
      update: (m, ctx, dt) => {
        if (!moveTo(m, 6, dt)) return
        ctx.emit('fire:fed', { amount: 0.22 })
        // merry: straight back for another one
        return m.merry > 0.4 && wantsToFeed(m, ctx) ? 'feed' : 'idle'
      },
      exit: (m) => (m.carrying = false),
    },
    toHut: {
      // walk up to the door
      enter: (m) => {
        m.tx = doorX(m.hut!)
        m.tz = PROPS.huts[m.hut!].z + HUT.front
      },
      update: (m, _ctx, dt) => (moveTo(m, 6, dt) ? 'entering' : undefined),
    },
    entering: {
      // step through the open door; the hut's walls hide them as they pass inside
      enter: (m) => (m.tz = PROPS.huts[m.hut!].z + HUT.inside),
      update: (m, _ctx, dt) => (moveTo(m, 3, dt, true) ? 'asleep' : undefined),
    },
    asleep: {
      update: (m, ctx, dt) => {
        if (Math.random() < dt * 0.5) ctx.w.zs.push({ hut: m.hut!, age: 0 })
        return m.energy >= 1 ? 'exiting' : undefined
      },
      on: { 'rain:start': () => 'exiting' },
    },
    farewell: {
      // one last moment beside the knight
      enter: (m, ctx) => {
        m.tx = ctx.w.knight.x + 6
        m.tz = ctx.w.knight.z + 3
        m.wait = 3
      },
      update: (m, ctx, dt) => {
        if (!moveTo(m, 4 * pace(m), dt)) return
        face(m, ctx.w.knight.x)
        return (m.wait -= dt) <= 0 ? 'departing' : undefined
      },
    },
    departing: {
      enter: (m, ctx) => {
        m.route = ROAD.map((p) => [...p] as [number, number])
        ;[m.tx, m.tz] = m.route[0]
        const who = isElder(m) ? `Elder ${m.name}` : m.name
        tell(
          ctx.w,
          pick([
            `${who} said goodbye to the knight and set off down the road, lantern in hand.`,
            `${who} took a lantern and went off down the road, to see what lay beyond the wood.`,
            `${who} bowed to the knight, lit a lantern, and left by the road.`,
            `With a last look back at the fire, ${who} set off down the road.`,
          ]),
        )
      },
      update: (m, _ctx, dt) => {
        if (followRoute(m, 4 * pace(m), dt)) m.gone = true
      },
    },
    wilting: {
      // walk to the quiet grove, settle among the others, and sink back into the soil
      enter: (m, ctx) => {
        let spot = restingPlace(ctx.w, m)
        if (spot === null) {
          // the grove is full: the oldest glowcap has faded, and its place is free again
          const old = ctx.w.memorials.shift()!
          tell(ctx.w, `${old.name}'s glowcap faded at last. The grove remembered them still.`)
          spot = old.spot
        }
        m.spot = spot
        ;[m.tx, m.tz] = GROVE_SPOTS[spot]
        m.sink = 0
      },
      update: (m, ctx, dt) => {
        if (!moveTo(m, 3.5 * pace(m), dt)) return
        if ((m.sink += dt / 6) < 1) return
        // everyone who knew them misses them, the closest at once (it hits hardest at first)
        const knew = ctx.w.mush.filter((o) => o !== m && !o.gone && (o.bonds[m.id] ?? 0) > 0)
        for (const o of knew) o.grief[m.id] = 0.6 * (o.bonds[m.id] ?? 0)
        ctx.w.memorials.push({
          who: m.id,
          at: ctx.w.t,
          x: m.x,
          z: m.z,
          name: m.name,
          ph: Math.random() * 6,
          spot: m.spot!,
          warmth: 0,
          knew: knew.map((o) => o.id),
        })
        // beside a close friend who went before: the story says so
        const friend = restsBeside(ctx.w, m, m.x, m.z)
        if (friend)
          tell(
            ctx.w,
            pick([
              `Elder ${m.name} returned to the soil beside ${friend.name}'s glowcap.`,
              `Elder ${m.name} lay down in the quiet grove next to ${friend.name}, and went back to the soil.`,
              `In the quiet grove, Elder ${m.name} came to rest beside ${friend.name}. Their glowcaps glowed side by side.`,
            ]),
          )
        else
          tell(
            ctx.w,
            pick([
              `Elder ${m.name} returned to the soil in the quiet grove, and a glowcap grew where they rested.`,
              `Elder ${m.name} lay down in the quiet grove and went back to the soil. A glowcap came up in their place.`,
              `In the quiet grove, Elder ${m.name} sank into the soil for good. Before long, a glowcap glowed there.`,
              `Elder ${m.name} went to the grove one last time, and stayed. A glowcap marked the spot.`,
            ]),
          )
        m.gone = true
      },
    },
    tend: {
      // walk to the grove and relight every candle
      enter: (m) => {
        m.tx = GROVE.x - 2
        m.tz = GROVE.z + 7
        m.wait = 3
      },
      update: (m, ctx, dt) => {
        if (!moveTo(m, 5 * pace(m), dt)) return
        face(m, GROVE.x) // toward the candles
        if ((m.wait -= dt) > 0) return
        const wasOut = ctx.w.candles.some((c) => !c.lit)
        for (const c of ctx.w.candles) {
          c.wax = 1
          c.lit = true
        }
        if (wasOut && Math.random() < 0.3)
          tell(
            ctx.w,
            pick([
              `${m.name} relit the candles in the quiet grove.`,
              `${m.name} went to the grove and lit the candles again, one by one.`,
              `The candles in the quiet grove burned again: ${m.name} had seen to them.`,
            ]),
          )
        return 'idle'
      },
      on: { 'rain:start': () => 'idle' },
    },
    visit: {
      // sit a while by a friend's glowcap
      enter: (m, ctx) => {
        const g = ctx.w.memorials[m.spot ?? 0]
        if (!g) return
        m.tx = g.x + 2.5
        m.tz = g.z + 1.5
        m.wait = rand(6, 10)
        if (Math.random() < 0.5) {
          tell(
            ctx.w,
            pick([
              `${m.name} sat by ${g.name}'s glowcap for a while.`,
              `${m.name} told ${g.name}'s glowcap about the night.`,
              `${m.name} left a leaf by ${g.name}'s glowcap.`,
              `${m.name} missed ${g.name}, and went to sit with them a while.`,
            ]),
          )
        }
      },
      update: (m, ctx, dt) => {
        if (!ctx.w.memorials[m.spot ?? 0]) return 'idle'
        if (!moveTo(m, 4 * pace(m), dt)) return
        face(m, ctx.w.memorials[m.spot ?? 0].x)
        if ((m.wait -= dt) > 0) return
        m.grief[ctx.w.memorials[m.spot ?? 0].who] = 0 // a while together eases it (for now)
        return 'idle'
      },
      exit: (m) => (m.spot = null),
      on: { 'rain:start': () => 'idle' },
    },
    sing: {
      // to a place by the fire, then sing (notes drift up); the song lasts a while once they're there
      enter: (m, ctx) => {
        const a = Math.atan2(m.z / RING_Z, m.x)
        m.tx = Math.cos(a) * songRing(ctx.w)
        m.tz = Math.sin(a) * songRing(ctx.w) * RING_Z
        m.wait = rand(45, 70) // long enough for the dancers to go round the fire a time or two
      },
      update: (m, ctx, dt) => {
        const song = ctx.w.song
        if (!song || song.singer !== m.id) return 'idle'
        if (!moveTo(m, 5 * pace(m), dt)) return
        face(m, 0)
        if (song.until === Infinity) {
          // in place: the song begins (and the story tells whether anyone came)
          song.until = ctx.w.t + m.wait
          const came = countIn(ctx.w.mush, 'join', 'offer', 'dance')
          tell(ctx.w, came ? `${m.name} started a song by the fire, and the others joined in.` : `${m.name} sang softly to the fire.`)
        }
        if (Math.random() < dt * 1.6) ctx.w.notes.push({ x: m.x, z: m.z, age: 0, sway: rand(0, 6) })
        return ctx.w.t >= song.until ? 'idle' : undefined
      },
      exit: (m, ctx) => {
        if (ctx.w.song?.singer !== m.id) return
        ctx.w.song = null // the dancers notice, and drift off one by one
        if (Math.random() < 0.4) tell(ctx.w, pick(SONG_ENDS))
      },
    },
    join: {
      // bring a piece of wood for the song: from the pile or off the ground, whichever is nearer
      enter: (m, ctx) => {
        const w = ctx.w
        m.merry = Math.min(1, m.merry + 0.3)
        const far = (x: number, z: number) => Math.hypot(x - m.x, z - m.z)
        const free = w.sticks.filter((s) => !s.claimed && s.landed)
        const stick = free.length ? free.reduce((a, b) => (far(a.x, a.z) < far(b.x, b.z) ? a : b)) : null
        if (stick && far(stick.x, stick.z) < (w.pile > 0 ? far(...PILE_SPOT) : Infinity)) {
          stick.claimed = true
          m.claim = stick
          m.tx = stick.x
          m.tz = stick.z
        } else [m.tx, m.tz] = PILE_SPOT
      },
      update: (m, ctx, dt) => {
        const w = ctx.w
        if (!w.song) return 'idle'
        if (m.claim && !w.sticks.includes(m.claim)) m.claim = null
        if (!m.claim && w.pile <= 0) return 'dance' // nothing left to bring: just dance
        if (!moveTo(m, 7 * pace(m), dt)) return
        if (m.claim) {
          w.sticks.splice(w.sticks.indexOf(m.claim), 1)
          m.claim = null
        } else w.pile--
        return 'offer'
      },
      exit: (m) => {
        if (m.claim) m.claim.claimed = false
        m.claim = null
      },
    },
    offer: {
      // and throw it on the fire, from their side of it
      enter: (m) => {
        m.carrying = true
        const a = Math.atan2(m.z, m.x)
        m.tx = Math.cos(a) * 7
        m.tz = Math.sin(a) * 4.5
      },
      update: (m, ctx, dt) => {
        if (!moveTo(m, 6, dt)) return
        ctx.emit('fire:fed', { amount: 0.22 })
        return ctx.w.song ? 'dance' : 'idle'
      },
      exit: (m) => (m.carrying = false),
    },
    dance: {
      // round the fire in a ring, stepping and turning, until the song ends; then drift off one by one
      enter: (m) => {
        m.ring = Math.atan2(m.z / RING_Z, m.x)
        m.wait = rand(0.5, 5)
      },
      update: (m, ctx, dt) => {
        const w = ctx.w
        if (!w.song && (m.wait -= dt) <= 0) return 'idle'
        // the fire dying right down: the most diligent breaks off to feed it
        if (w.fire.fuel < 0.15 && w.pile > 0 && feeders(ctx) === 0 && Math.random() < dt * m.diligence) return 'feed'
        const r = danceRing(w)
        const off = Math.abs(Math.hypot(m.x, m.z / RING_Z) - r)
        if (off > 3) {
          // find their way to the ring first (a fixed point on it, so the path is found once)
          m.tx = Math.cos(m.ring) * r
          m.tz = Math.sin(m.ring) * r * RING_Z
          moveTo(m, 5, dt)
          return
        }
        // then round it, stepping and turning (straight along the ring: it's open ground)
        m.ring += dt * 0.25
        m.tx = Math.cos(m.ring) * r
        m.tz = Math.sin(m.ring) * r * RING_Z
        moveTo(m, 4, dt, true)
        m.flip = Math.sin(w.t * 1.8 + m.seed * 9) > 0
      },
    },
    keep: {
      // the keeper sits where the knight sat, facing the fire
      enter: (m, ctx) => {
        m.tx = ctx.w.knight.home.x
        m.tz = ctx.w.knight.home.z
        m.wait = rand(12, 25)
      },
      update: (m, _ctx, dt) => {
        if (!moveTo(m, 4 * pace(m), dt)) return
        face(m, 0) // the fire
        return (m.wait -= dt) <= 0 ? 'idle' : undefined
      },
    },
    exiting: {
      enter: (m) => {
        m.x = m.tx = doorX(m.hut!)
        m.z = PROPS.huts[m.hut!].z + HUT.inside
        m.tz = PROPS.huts[m.hut!].z + HUT.front + 1
      },
      update: (m, _ctx, dt) => (moveTo(m, 3, dt, true) ? 'idle' : undefined),
      exit: (m) => (m.hut = null),
    },
    // the visitor's hand has them (sim/hand.ts moves them); nothing to do but kick
    carried: {},
    // set down: a little fall, a puff of dust, a dizzy wobble, then back to it
    dizzy: {
      enter: (m) => {
        m.fall = 0
      },
      update: (m, ctx, dt) => {
        if ((m.air ?? 0) > 0) {
          m.fall = (m.fall ?? 0) + dt * 40
          m.air = Math.max(0, (m.air ?? 0) - m.fall * dt)
          if (m.air === 0) for (let i = 0; i < 4; i++) ctx.w.puffs.push({ x: m.x, z: m.z, age: -i * 0.05, seed: Math.random() * 100 })
          m.fsm.time = 0
          return
        }
        m.flip = Math.sin(m.fsm.time * 9) > 0 // looking this way and that
        return m.fsm.time > 2.2 ? 'idle' : undefined
      },
      exit: (m) => {
        m.air = 0
        m.fall = 0
      },
    },
  },
  on: {
    // the rain's over: those by the fire are glad of it
    'rain:end': (m) => {
      if (Math.hypot(m.x, m.z) < 34) m.merry = Math.min(1, m.merry + 0.4)
    },
    // a song by the fire: anyone free and near enough to hear it comes, bringing wood (those
    // already hauling a stick to the pile take it straight to the fire)
    'song:start': (m, ctx) => {
      if (m.id === ctx.w.song?.singer || !adult(m) || Math.hypot(m.x, m.z) > 70) return
      if (m.fsm.state === 'haul') return 'offer'
      return JOINABLE.includes(m.fsm.state) ? 'join' : undefined
    },
  },
}

/** Someone free starts a song by the fire now (the debug console): the one nearest the fire. */
export function startSong(w: World): boolean {
  const free = w.mush.filter((m) => m.size >= 1 && JOINABLE.includes(m.fsm.state))
  if (w.song || !free.length) return false
  const m = free.reduce((a, b) => (Math.hypot(a.x, a.z) < Math.hypot(b.x, b.z) ? a : b))
  const ctx = ctxFor(w)
  beginSong(m, ctx)
  transition(mushMachine, m, ctx, 'sing')
  return true
}

/** The most the village grows to (by sprouts after rain, and travelers). */
export const MAX_VILLAGE = 7

/** A traveler comes up the road, and the village takes them in. */
export function welcomeTraveler(w: World) {
  const m = createTraveler(w)
  w.mush.push(m)
  // a welcome: those by the fire are merry, and want it built up for the newcomer
  for (const o of w.mush) if (Math.hypot(o.x, o.z) < 34) o.merry = Math.min(1, o.merry + 0.45)
  tell(
    w,
    pick([
      `A traveler came up the road. The village took them in and called them ${m.name}.`,
      `A lantern bobbed up the road: a traveler. The village made room by the fire, and named them ${m.name}.`,
      `Someone new came out of the dark along the road. Soon they were ${m.name}, one of the village.`,
      `A tired traveler found the fire. The village called them ${m.name}, and they stayed.`,
    ]),
  )
}
