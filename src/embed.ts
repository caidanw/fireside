/**
 * The scene alone, for the frame X puts inside a post (embed/index.html; the home page's player
 * card points here). It starts straight away, silent until the sound is turned on:
 * X has already shown a still and a play button, and browsers only allow sound after a click.
 */
import { startDarkForest, type DarkForestState } from './index'
import { followHand, handForPage } from './cursor'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const sound = document.querySelector<HTMLButtonElement>('[data-toggle=sound]')!
const sync = (s: DarkForestState) => sound.setAttribute('aria-pressed', String(s.sound))
const forest = startDarkForest(canvas, { onChange: sync })
sync(forest.state())
sound.addEventListener('click', () => forest.toggleSound())
handForPage('point')
followHand(canvas, forest.handPose)
