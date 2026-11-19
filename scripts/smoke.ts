/**
 * A night run without a browser: ten minutes of the sim (the visitor's hand used along the way, and
 * a storm), drawn every few seconds. It fails on any error or a creature somewhere impossible, and
 * prints a fingerprint of the frames: the same seed gives the same fingerprint, so a change that
 * shouldn't alter a pixel (a rename, a move, a split) can show that it didn't.
 *   node scripts/run.mjs scripts/smoke.ts [seed] [minutes]
 */
import { createHash } from 'node:crypto'
import { hashFrame, headless } from './headless'

const seed = Number(process.argv[2] ?? 1)
const minutes = Number(process.argv[3] ?? 10)
const { world, sim, run, frame } = await headless(seed)
const prints = createHash('sha256')
let frames = 0
const look = () => {
  prints.update(hashFrame(frame()))
  frames++
  for (const m of world.mush) if (![m.x, m.z, m.age].every(Number.isFinite)) throw new Error(`${m.name} is nowhere (${m.x}, ${m.z}) at ${world.t.toFixed(1)}s`)
}

// what a visitor might do, and when (seconds in)
const fire = { x: 0, z: 0, y: 10 }
const hand: [number, () => void][] = [
  [30, () => sim.grab(world, 'woodpile', 25, -5, 10) && (sim.moveHand(world, fire.x, fire.z + 12, fire.y), sim.release(world))],
  [60, () => sim.grab(world, 'fire', 0, 6, 10) && (sim.moveHand(world, -30, 24, 10), sim.release(world))],
  [90, () => sim.grab(world, 'lantern', -90, 16, 10) && (sim.moveHand(world, -40, 30, 10), sim.release(world))],
  [
    120,
    () => {
      const m = world.mush.find((m) => sim.takeable(world, `mush${m.id}`))
      if (m && sim.grab(world, `mush${m.id}`, m.x, m.z, 10)) (sim.moveHand(world, m.x + 10, m.z, 10), sim.release(world))
    },
  ],
  [180, () => sim.toggleRain(world)],
  [300, () => sim.toggleRain(world)],
]
for (let s = 0; s < minutes * 60; s += 5) {
  for (const [at, act] of hand) if (at >= s && at < s + 5) act()
  run(5)
  look()
}
const told = world.told.join(', ') || 'nothing'
console.log(`seed ${seed}, ${minutes} min: ${frames} frames, ${world.mush.length} shroomfolk, the story told: ${told}`)
console.log(`frames ${prints.digest('hex').slice(0, 16)}`)
