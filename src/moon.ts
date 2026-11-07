/**
 * The moon's night: it climbs out of the trees on the left of the clearing, arcs over the open
 * sky above it, curls round to the right and sinks back down into the old trigon stone. While it's gone (a short while) the stone turns it,
 * and it rises again on the left in its next phase. The world is always night; the moon is
 * what changes.
 *
 * Shared by the sim (the clock, the story) and the renderer (where it is, how it's lit).
 */
import { DATA } from './art'
import { PROPS, RES, W, project } from './world'

/** Where the stone stands on screen (the moon's path is laid out around it). */
export const stoneX = () => project(PROPS.trigon.x, 0, PROPS.trigon.z)[0]

/** The phases it goes through, one per crossing: degrees from full (0) toward new (180). Never quite new, so a moon is always there. */
export const PHASES = [150, 105, 60, 0, 60, 105, 150, 170]
/** Which phases are waxing (lit on the right) rather than waning (lit on the left). */
export const waxing = (phase: number) => phase % PHASES.length < 3

/** The moon's clock: seconds into this cycle (a crossing, then the time it's hidden), and its phase. */
export interface MoonClock {
  t: number
  phase: number
}

/** How long a crossing takes, and how long it stays behind the stone (seconds; families.json moon.path). */
export function moonTiming() {
  const p = DATA.families.moon?.path
  return { crossing: Math.max(10, p?.crossing ?? 600), hidden: Math.max(1, p?.hidden ?? 45) }
}

/** The moon's radius in screen pixels. */
export const MOON_R = 7 * RES

export interface MoonPlace {
  /** Is it in the sky (not hidden behind the stone)? */
  up: boolean
  /** Its centre in screen pixels (whole pixels). */
  x: number
  y: number
  /** How far along its crossing (0 rising .. 1 behind the stone). */
  along: number
  /** Degrees from full (0) toward new (180), and which way the lit side faces on screen (degrees, 0 right, 90 up). */
  phase: number
  angle: number
  /** Seconds since it went behind the stone (while hidden). */
  hiddenFor: number
}

/**
 * The path, a cubic curve in screen pixels, through the open sky above the stone (the crowns
 * leave a window there): up from behind the trees on its left, over the top, round to the
 * right and down into the stone. It's laid out from the stone, so it follows it if it moves.
 */
function pathAt(u: number): [number, number] {
  const [tx, ty, ts] = project(PROPS.trigon.x, 0, PROPS.trigon.z)
  const P: [number, number][] = [
    [tx - 40 * RES, 55 * RES],
    [tx - 30 * RES, -5 * RES],
    [tx + 55 * RES, -5 * RES],
    [tx, ty - 20 * ts], // the middle of the stone
  ]
  const v = 1 - u
  const a = v * v * v
  const b = 3 * v * v * u
  const c = 3 * v * u * u
  const d = u * u * u
  return [a * P[0][0] + b * P[1][0] + c * P[2][0] + d * P[3][0], a * P[0][1] + b * P[1][1] + c * P[2][1] + d * P[3][1]]
}

/** Where the moon is and how it looks, for a clock. */
export function moonPlace(m: MoonClock): MoonPlace {
  const { crossing } = moonTiming()
  const phase = PHASES[((m.phase % PHASES.length) + PHASES.length) % PHASES.length]
  const up = m.t < crossing
  const along = Math.min(1, m.t / crossing)
  const [px, py] = pathAt(along)
  const x = Math.round(px)
  const y = Math.round(py)
  // the lit side faces the sun, below the horizon: off to the right while waxing, the left while waning
  const sx = waxing(m.phase) ? W + 125 * RES : -125 * RES
  const sy = 196 * RES
  const angle = (Math.atan2(-(sy - y), sx - x) * 180) / Math.PI
  return { up, x, y, along, phase, angle, hiddenFor: up ? 0 : m.t - crossing }
}
