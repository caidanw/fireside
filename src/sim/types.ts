import type { Point } from '../world'
import type { Fsm, MachineDef } from './fsm'

/** Everything entities can tell each other. Add an event here, then handle it in any machine. */
export interface SimEvents {
  'weather:toggle': undefined
  'rain:start': undefined
  'rain:end': undefined
  'fire:low': undefined
  'fire:fed': { amount: number }
  /** A stick has come down (from the trees, or out of the visitor's hand) and lies on the ground. */
  'stick:landed': Stick
  /** Someone has started a song by the fire: those free come, bringing wood, and dance. */
  'song:start': undefined
  /** The visitor's hand is over the clearing, at this ground point (sent every tick while it is). */
  hand: Point
  /** The visitor's hand reached for something (by its hover key), whether or not it could take it. */
  'hand:reach': { key: string }
}
export type SimEvent = { [K in keyof SimEvents]: { type: K; payload: SimEvents[K] } }[keyof SimEvents]

export interface Ctx {
  w: World
  emit<K extends keyof SimEvents>(type: K, ...payload: SimEvents[K] extends undefined ? [] : [SimEvents[K]]): void
}

/** Shorthand for a machine definition in this sim. */
export type Def<E extends { fsm: Fsm<S> }, S extends string> = MachineDef<E, Ctx, S, SimEvents>

export interface Walker extends Point {
  tx: number
  tz: number
  flip: boolean
  /** Waypoints toward (tx, tz) and the target they were found for (see nav.ts). */
  path?: [number, number][]
  pathKey?: string
}

// ---------- entities (each owns an fsm) ----------
export type WeatherState = 'dry' | 'gathering' | 'raining' | 'easing' | 'clearing'
export interface Weather {
  fsm: Fsm<WeatherState>
  timer: number
  /** Once the visitor toggles rain by hand, the automatic cycle stops. */
  manual: boolean
  /** Cloud cover (0..1): drifts in before the rain and away after it. */
  cloud: number
  /** How hard it's raining (0..1): eases in and out. Above 0.3 counts as raining. */
  rain: number
  /** How hard this rain will get at its heaviest. */
  peak: number
  /** A lightning flash's brightness (decays fast). */
  flash: number
  /** The bolt being drawn: where it strikes (screen x), its shape, and its age in seconds. */
  bolt: { x: number; seed: number; age: number } | null
  /** Seconds until the next lightning. */
  nextStrike: number
  /** Thunder on its way: when it arrives (sim seconds), how far away it struck (km) and where (pan −1..1). */
  thunder: { at: number; distance: number; pan: number }[]
  /** Whether it counted as raining last tick (to announce the change). */
  raining: boolean
}

export type FireState = 'embers' | 'low' | 'steady' | 'roaring' | 'blazing'
export interface Fire {
  fsm: Fsm<FireState>
  fuel: number
  /** What the fire looks like right now: chases fuel with lag, so a new log catches gradually. */
  heat: number
  /** A short-lived kick added on top of fuel (a fresh log roars, rain makes it hiss and sink). */
  flare: number
  /** When it last blazed up (so the story only remarks on it now and then). */
  lastBlaze: number
}

export type KnightState = 'resting' | 'nodding' | 'tending' | 'rising' | 'walking' | 'kneeling' | 'gone'
export interface Knight extends Walker {
  fsm: Fsm<KnightState>
  headDown: boolean
  /** Where he sits by the fire (the keeper sits here after him). */
  home: Point
  /** Seconds of vigil kept, and how long it lasts before he goes to rest. */
  vigil: number
  vigilLength: number
  route: [number, number][]
  sword: 'planted' | 'carried' | 'laid'
  step: number
  /** Seconds until he'll next lean over and add a log himself. */
  tend: number
}

export type MushState =
  | 'arriving' // a traveler coming up the road
  | 'sprouting'
  | 'idle'
  | 'wander'
  | 'fetch'
  | 'haul'
  | 'feed'
  | 'stoke'
  | 'toHut'
  | 'entering'
  | 'asleep'
  | 'exiting'
  | 'farewell' // end of life: one last moment by the knight...
  | 'departing' // ...then off down the road with a lantern
  | 'wilting' // or: walk to the quiet grove and return to the soil
  | 'tend' // relight the candles at the grove
  | 'visit' // sit a while by a friend's glowcap
  | 'keep' // the keeper sits in the knight's place by the fire
  | 'sing' // start a song by the fire...
  | 'join' // ...the others fetch a piece of wood (the pile or a stick, whichever is nearer)...
  | 'offer' // ...throw it on the fire...
  | 'dance' // ...and dance round it until the song ends
  | 'carried' // picked up by the visitor's hand
  | 'dizzy' // set down again: a little fall, a wobble, then back to it
export interface Mush extends Walker {
  fsm: Fsm<MushState>
  /** Who they are (counted up by the world), and a random 0..1 that varies their looks and timing. */
  id: number
  seed: number
  name: string
  /** Seconds lived, and how long this one gets. Past ~75% they're an elder. */
  age: number
  lifespan: number
  /** Route for arriving / departing (consumed front to back). */
  route: [number, number][]
  /** 0..1 while sinking back into the soil. */
  sink: number
  /** Set when they've left the scene for good; removed at the end of the tick. */
  gone: boolean
  /** Grove spot they're heading to (wilting), or the glowcap they're visiting. */
  spot: number | null
  /** When they last visited the grove (sim seconds). */
  /** How close they are to each of the others (by id, 0..1): it grows with time spent near each other. */
  bonds: Record<number, number>
  /** How much they miss each friend who has died (by the friend's id): it grows, faster the closer
   * they were, until they go and sit by the friend's glowcap, which eases it. */
  grief: Record<number, number>
  /** How their life ends, if it's already decided (the opening's old one goes to the grove). */
  fate?: 'farewell' | 'wilting'
  wait: number
  warmth: number
  /** Rest need: drains while awake (faster while working), refills asleep in a hut. */
  energy: number
  /** The hut this one prefers to sleep in. */
  home: number
  size: number
  carrying: boolean
  /** Height off the ground while carried or falling (world units). */
  air?: number
  /** How fast they're falling, once set down. */
  fall?: number
  claim: Stick | null
  /** Carrying a bundle from the forest (two for the pile). */
  bundle?: boolean
  hut: number | null
  /**
   * Who they are around the fire. diligence: how soon they notice it needs feeding; hardy:
   * how little the cold bothers them; likes: the size of fire they're happy with (0..1.2);
   * merry: a festive mood (0..1) that spreads between those gathered by the fire, and wants
   * the fire built high.
   */
  diligence: number
  hardy: number
  likes: number
  merry: number
  /** Where they are round the fire while dancing (an angle). */
  ring: number
}

export type DeerState = 'graze' | 'walk' | 'toPool' | 'drink' | 'flee'
export interface Deer extends Walker {
  fsm: Fsm<DeerState>
  wait: number
  thirst: number
  step: number
}

export type FrogState = 'sit' | 'hop' | 'catch'
export interface Frog {
  fsm: Fsm<FrogState>
  pad: number
  from: number
  progress: number
  next: number
  croak: number
  /** A firefly in reach: which one, where it was when the tongue went out, and how long ago. */
  catch: { fly: number; x: number; y: number; z: number; t: number } | null
  /** Which way it faces, sitting (1 right, -1 left); 0 is the way it last hopped. */
  facing: number
  /** Seconds since it last ate. */
  fed: number
}

export type CrowState = 'perch' | 'flying' | 'away' | 'returning'
export interface Crow {
  fsm: Fsm<CrowState>
  x: number
  y: number
  vx: number
  vy: number
}

export interface Stick extends Point {
  /** Gathered at the forest's edge: a bundle (two for the pile). */
  bundle?: boolean
  /** A log the visitor set down (drawn as a log; one for the pile). */
  log?: boolean
  claimed: boolean
  /** Height above the ground while falling, vertical speed, and tumble. */
  y: number
  vy: number
  angle: number
  spin: number
  landed: boolean
  /** 1 when freshly dropped by the visitor, fading to 0 after it lands (so you can see where it went). */
  glint: number
}

/** The moments the first minutes of a night are arranged around (sim/opening.ts). */
export type OpeningBeat = 'toss' | 'song' | 'traveler'

/** What the visitor's hand is holding. */
export type Held = { kind: 'log' } | { kind: 'stick'; lit: boolean; burn: number } | { kind: 'lantern' } | { kind: 'folk'; id: number }

/** The visitor's hand: where it is (the ground under what it holds), how high, and what it holds. */
export interface Hand {
  x: number
  z: number
  y: number
  held: Held | null
  /** Seconds an unlit stick has been held over the fire (it catches at about one). */
  catching: number
}

export interface World {
  t: number
  pile: number
  poolLevel: number
  rune: number
  weather: Weather
  fire: Fire
  knight: Knight
  deer: Deer
  frog: Frog
  crow: Crow
  mush: Mush[]
  sticks: Stick[]
  /** The visitor's hand (null when the pointer isn't over the clearing). */
  hand: Hand | null
  /** What the visitor has done that the story has told already (it tells each once). */
  told: string[]
  /** The next shroomfolk's id. */
  nextId: number
  /** Every name given this night, the most recent last (names come round again only once all are used). */
  named: string[]
  /** The opening's beats still to come: each tried from its time until its window closes. */
  opening: { beat: OpeningBeat; at: number; until: number }[]
  /** The road lantern: on its post, or wherever it was set down (while held, the hand has it); height and speed while it falls. */
  lantern: { onPost: boolean; x: number; z: number; y: number; vy: number }
  /** Sticks set down still burning (falling first: height and speed), until they go out. */
  brands: { x: number; z: number; burn: number; y: number; vy: number }[]
  /** Logs in the air, thrown on the fire by the knight: where, how high, how fast, and their tumble. */
  tossed: { x: number; z: number; y: number; vx: number; vz: number; vy: number; angle: number; spin: number }[]
  stickTimer: number
  /** Glowcaps that grew where shroomfolk returned to the soil, each on a grove spot. */
  /** Glowcaps where shroomfolk returned to the soil: whose, its pulse, its grove spot, how warm it
   * glows (0..1: it brightens while a friend sits by it), when they died, and who knew them (the ids
   * of the village when they died: only they come to visit). */
  memorials: (Point & { who: number; at: number; name: string; ph: number; spot: number; warmth: number; knew: number[] })[]
  /** One candle per grave: wax left (1 = fresh) and whether it's lit. */
  candles: { wax: number; lit: boolean }[]
  /** The shroomfolk who took up the knight's place, once he's gone. */
  keeperId: number | null
  /** Countdown to the next traveler, if the village is small. */
  arrivalTimer: number
  /** Story lines waiting to be shown by the page. */
  story: string[]
  // ambient particles (no state machines; just systems)
  embers: { ox: number; oy: number; vx: number; vy: number; life: number; age: number; ph: number }[]
  drops: { x: number; y: number; v: number; stop: number }[]
  ripples: { x: number; y: number; age: number }[]
  zs: { hut: number; age: number }[]
  /** A song by the fire: who's singing, and when it ends (open until the singer is in place). */
  song: { singer: number; until: number } | null
  /** Notes drifting up from the singer. */
  notes: { x: number; z: number; age: number; sway: number }[]
  /** Dust kicked up where something lands. */
  puffs: { x: number; z: number; age: number; seed: number }[]
  /** Fireflies about the clearing; one eaten by the frog is gone a while (gone: seconds left). */
  flies: { seed: number; x: number; y: number; z: number; a: number; gone?: number }[]
  /** Now and then a firefly drifts down low over the pool, where the frog is: which one, how far into it, for how long. */
  flyDip: { fly: number; t: number; len: number } | null
  nextDip: number
  shooting: { x: number; y: number; age: number } | null
  nextShoot: number
  /** Bats crossing the sky (screen space: x, y, speed, wingbeat phase). */
  bats: { x: number; y: number; vx: number; ph: number }[]
  nextBats: number
  /** Moths circling a light (world space), and which light. */
  /**
   * Moths circling the fire or the lantern. Each circles a centre of its own (follow), sprung toward
   * the light, so a carried lantern's moths trail behind it and swing past when it stops.
   */
  moths: {
    seed: number
    at: 'fire' | 'lantern'
    x: number
    y: number
    z: number
    follow?: { x: number; y: number; z: number; vx: number; vy: number; vz: number }
  }[]
  /** Firefly swarms deep in the trees (world space). */
  farFlies: { seed: number; cx: number; cz: number; x: number; y: number; z: number; a: number }[]
  /** The moon's clock: seconds into its cycle (crossing, then hidden behind the stone) and its phase (moon.ts). */
  moon: { t: number; phase: number }
  /** The owl on its branch: blinking, and now and then looking away. */
  owl: { blink: number; away: number }
  /** A deer far off, crossing the back of the wood now and then. */
  farDeer: { x: number; z: number; dir: number; step: number } | null
  nextFarDeer: number
  /** Events emitted this tick, delivered to every agent at the end of the tick. */
  queue: SimEvent[]
}
