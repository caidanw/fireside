/**
 * The site's share images, rendered from the scene: the link preview (og.png), the still X shows
 * before its player (card-player.png), and the app icons (the campfire). Rerun after changing the
 * art:
 *   node scripts/run.mjs scripts/share-images.ts
 */
import { crop, headless, rgb, scale, writePng, type Image } from './headless'

// a good moment: a full moon high, the fire bright, the village up (and a deer close to the fire)
const { world, moonTiming, run, frame } = await headless(11)
world.moon.phase = 3 // full
run(90, () => {
  world.weather.rain = 0
  world.weather.cloud = 0
  world.fire.fuel = Math.max(world.fire.fuel, 0.85)
})
world.moon.t = 0.35 * moonTiming().crossing
let snap = frame()
for (let i = 0; i < 2; i++) {
  run(1 / 60)
  snap = frame()
}
const scene: Image = { data: rgb(snap), w: 640, h: 360 }

const out = (name: string, img: Image) => {
  writePng(`public/${name}`, img)
  console.log(`public/${name}  ${img.w}x${img.h}`)
}
out('og.png', scale(crop(scene, 115, 112, 400, 210), 3)) // the fire, the knight and the huts, 1200x630
out('card-player.png', scale(scene, 2)) // the whole clearing, the player's 16:9
const fire = crop(scene, 288, 197, 64, 64)
out('icon-192.png', scale(fire, 3))
out('icon-512.png', scale(fire, 8))
out('apple-touch-icon.png', scale(crop(scene, 290, 199, 60, 60), 3))
