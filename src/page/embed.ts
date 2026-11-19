/**
 * The scene alone, for the frame X puts inside a post (embed/index.html; the home page's player
 * card points here). It starts straight away (X has already shown a still and a play button),
 * silent until the first tap or click on it.
 */
import { startFireside, type FiresideState } from '../engine/fireside'
import { followHand, handForPage } from './cursor'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const sound = document.querySelector<HTMLButtonElement>('[data-toggle=sound]')!
const sync = (s: FiresideState) => sound.setAttribute('aria-pressed', String(s.sound))
const forest = startFireside(canvas, { onChange: sync })
sync(forest.state())
// Like a video in the timeline: silent until the first touch, and then the first touch anywhere on it
// brings the sound up (browsers only allow sound from inside the frame, after a click or a tap).
// Its button mutes and unmutes; once that's been used, the visitor has chosen.
let chosen = false
sound.addEventListener('click', () => {
  chosen = true
  forest.toggleSound()
})
// (on the lift: iPhones only let sound start on the end of a touch, not its start)
const listen = (e: Event) => {
  if (sound.contains(e.target as Node)) return
  removeEventListener('pointerup', listen)
  removeEventListener('keydown', listen)
  if (!chosen && !forest.state().sound) forest.toggleSound()
}
addEventListener('pointerup', listen)
addEventListener('keydown', listen)
handForPage('point')
followHand(canvas, forest.handPose)
