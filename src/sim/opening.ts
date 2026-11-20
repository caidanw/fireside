/**
 * The first minutes of a night, arranged so a visitor who stays a few minutes sees what the clearing
 * has (most stay under ten): at normal speed, a few moments are given a time, somewhere in a window,
 * so they come in a good order and never quite the same way twice. Each is tried from its time until
 * its window closes (if it can't happen yet: raining, nobody free to sing, no wood), then let go.
 * After about ten minutes the night is left to itself.
 *
 * Without a beat of their own, because the night is set up for them: the old one goes to the grove in
 * the first minute or two (their age, in createWorld), their closest friend comes to their glowcap a
 * few minutes later (grief), the frog is after a firefly within the first minute or two, and the first
 * rain comes at about six and a half to seven and a half minutes (the first dry spell).
 */
import { rand } from '../util'
import { ctxFor } from './helpers'
import { transition } from './fsm'
import { knightMachine } from './knight'
import { MAX_VILLAGE, startSong, welcomeTraveler } from './shroomfolk'
import type { OpeningBeat, World } from './types'

/** Each beat's window (minutes): it's given a time in the first part, and tried until the end. */
const BEATS: { beat: OpeningBeat; from: number; to: number }[] = [
  { beat: 'toss', from: 2, to: 4 }, // the knight feeds the fire
  { beat: 'song', from: 4, to: 5.5 }, // a song by the fire, and the others dance
  { beat: 'traveler', from: 7, to: 9 }, // someone new comes up the road
]

/** This night's opening: each beat at its own time. */
export function planOpening(): World['opening'] {
  return BEATS.map(({ beat, from, to }) => ({ beat, at: rand(from, (from + to) / 2) * 60, until: to * 60 }))
}

/** How long the first dry spell is (seconds), so the first rain comes after the visit and the song. */
export const FIRST_DRY = (): number => rand(330, 390)

/** Try whichever beats are due; drop those that happened, or whose window has closed. */
export function stepOpening(w: World) {
  if (!w.opening.length) return
  w.opening = w.opening.filter((b) => w.t < b.at || (!play(w, b.beat) && w.t < b.until))
}

function play(w: World, beat: OpeningBeat): boolean {
  if (beat === 'toss') {
    const k = w.knight
    if ((k.fsm.state !== 'resting' && k.fsm.state !== 'nodding') || w.pile <= 0) return false
    transition(knightMachine, k, ctxFor(w), 'tending')
    return true
  }
  if (beat === 'song') return w.weather.rain < 0.1 && startSong(w)
  if (w.mush.length >= MAX_VILLAGE) return true // (no room: nobody's coming, and that's fine)
  welcomeTraveler(w)
  return true
}
