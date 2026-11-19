/**
 * The visitor's hand on the canvas: pointer and touch input made into the sim's hand (sim/hand.ts).
 * Hover names things (and spooks the deer); press on something to take it, carry it, and let go to
 * set it down (or a click picks it up and the next click sets it down). On a touchscreen a tap names
 * a thing and a drag carries it, held up above the finger so it can be seen.
 */
import type { Renderer } from '../render/renderer'
import { grab, leaveHand, moveHand, release, takeable, type World } from '../sim'
import { H, W, project, unproject } from '../world'
import { settings } from './settings'

/** How the hand looks (a frame of the hand sprite): see page/cursor.ts. */
export type HandPose = 'point' | 'open' | 'fist' | 'torch' | 'pinch'

/** Listen for the visitor's hand on `canvas`. `onInspect`: the editor's inspect tool picked a pixel. */
export function handInput(canvas: HTMLCanvasElement, renderer: Renderer, world: World, onInspect?: () => void) {
  /** How high the hand holds things (world units), and how far above a finger (CSS pixels). */
  const HOLD = 10
  const ABOVE_FINGER = 40
  const toScreen = (e: PointerEvent, lifted = false) => {
    const r = canvas.getBoundingClientRect()
    const up = lifted && e.pointerType === 'touch' ? ABOVE_FINGER : 0
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - up - r.top) / r.height) * H }
  }
  /** Beyond this depth the hand holds things higher instead of further away (over the far trees and the sky). */
  const FAR = -70
  /** The ground point under a thing held at screen point (x, y), and how high it's held: [x, z, height]. */
  const holdAt = (x: number, y: number): [number, number, number] => {
    let q = unproject(x, y + HOLD * project(0, 0, 0)[2])
    for (let i = 0; i < 3 && q; i++) q = unproject(x, y + HOLD * project(0, 0, q[1])[2]) // refine for depth
    if (q && q[1] > FAR) return [q[0], q[1], HOLD]
    const [cx, gy, s] = project(0, 0, FAR)
    return [(x - cx) / s, FAR, Math.max(HOLD, (gy - y) / s)]
  }
  let pressed = false
  let pressAt = { x: 0, y: 0, t: 0 }
  /** Took hold with a click (short and still): the hand keeps it until the next click. */
  let sticky = false
  let pinned = false
  /** A finger on something it could take: dragging takes it, lifting the finger just names it. */
  let reaching: string | null = null
  const placeHand = (e: PointerEvent) => {
    const { x, y } = toScreen(e, !!world.hand?.held)
    const [hx, hz, hy] = holdAt(x, y)
    moveHand(world, hx, hz, hy)
  }
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && !pressed) return
    // a finger that's set off dragging from something takes it (a tap only names it)
    if (reaching && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) >= 6) {
      grab(world, reaching, world.hand!.x, world.hand!.z, world.hand!.y)
      reaching = null
    }
    pinned = false
    renderer.pointer = toScreen(e, !!world.hand?.held) // hover works anywhere, including over the sky
    placeHand(e) // (the deer keeps away from it)
  }
  const onLeave = (e: PointerEvent) => {
    if (pinned || (e.pointerType === 'touch' && !world.hand?.held)) return // a tapped name stays up
    renderer.pointer = null
    leaveHand(world)
  }
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const { x, y } = toScreen(e)
    if (settings.tool === 'move') return // the editor handles it
    if (settings.tool === 'inspect') {
      settings.inspect = { x: Math.floor(x), y: Math.floor(y) }
      onInspect?.()
      return
    }
    pressed = true
    pressAt = { x: e.clientX, y: e.clientY, t: performance.now() }
    renderer.pointer = { x, y }
    renderer.pick() // what's under a finger that's only just touched down
    // keep carrying past the canvas's edge (a pointer the browser doesn't know, like a synthetic one, can't be captured)
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {}
    placeHand(e)
    if (world.hand?.held) return // holding something from a click: this click's release sets it down
    sticky = false
    if (e.pointerType === 'touch') reaching = takeable(world, renderer.hoverKey) ? renderer.hoverKey : null
    else if (grab(world, renderer.hoverKey, world.hand!.x, world.hand!.z, world.hand!.y)) placeHand(e)
  }
  const onUp = (e: PointerEvent) => {
    if (!pressed) return
    pressed = false
    reaching = null
    const still = Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) < 6 && performance.now() - pressAt.t < 350
    if (world.hand?.held && still && !sticky && e.pointerType !== 'touch') {
      sticky = true // a click took it: keep hold until the next click
      return
    }
    sticky = false
    release(world)
    if (e.pointerType === 'touch') {
      // the tapped thing's name stays up until the next tap
      pinned = still
      if (!pinned) renderer.pointer = null
      leaveHand(world) // a finger lifted is gone (until it touches again)
    }
  }
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  const handPose = (): HandPose => {
    const held = world.hand?.held
    if (held?.kind === 'stick') return held.lit ? 'torch' : 'fist'
    if (held?.kind === 'log') return 'fist'
    if (held) return 'pinch'
    if (pressed) return 'fist'
    return renderer.pointer && takeable(world, renderer.hoverKey) ? 'open' : 'point'
  }
  return {
    handPose,
    detach() {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    },
  }
}
