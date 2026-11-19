/** Every light in the scene each frame, all in one model (lights.ts): the fire, lanterns, candles, caps, embers, fireflies... and the moon. */
import { DATA } from '../art/art'
import { settings } from '../engine/settings'
import { moonPlace, stoneX } from '../moon'
import { hutOccupancy, lightRadius, type World } from '../sim'
import { clamp, vnoise, type Color } from '../util'
import { HORIZON, PROPS, RES, SHROOMS, ZOOM } from '../world'
import { type MoonLight } from './gpu'
import { tagId } from './labels'
import { type Light } from './lights'
import { FIRE_Y, MOONLIGHT, VIEW, cloudAt, unit } from './look'
import type { Renderer } from './renderer'
import { HELD_STICK, stickTip } from './shapes'

/**
 * Every light in the scene this frame, all in the same model (see lights.ts).
 * Colours include brightness; flames wobble and spill, steady glows don't.
 */
export function sceneLights(ren: Renderer, w: World): Light[] {
  const t = w.t
  const heat = w.fire.heat
  const warm = (k: number): Color => [0.9 * k, 0.6 * k, 0.25 * k]
  const out: Light[] = []
  const fi = (0.3 + 0.7 * heat) * (0.84 + 0.16 * vnoise(t * 9, 3.3))
  out.push({
    kind: 'fire',
    name: 'campfire',
    x: 0,
    y: FIRE_Y,
    shadowY: FIRE_Y + 8,
    z: 0,
    radius: lightRadius(w),
    color: [1.7 * fi, 0.95 * fi, 0.42 * fi],
    wobble: 1,
    tail: 0.11,
    shadows: true,
    seed: 7,
  })
  {
    const fl = 0.85 + 0.15 * vnoise(t * 6, 7)
    out.push({
      kind: 'lantern',
      name: 'road lantern',
      owner: tagId('lantern'),
      // the same light wherever it is: in the visitor's hand, set down, or on its post, where it hangs
      // higher and reaches a little further, so the ground under it is lit as brightly. Its shadows
      // are cast as if it were held there (from lower down, just in front of the post's plane), so
      // the post throws a thin strip along the ground: casters are flat cut-outs, and a light inside
      // the post's smears its whole shape into a wedge, one above its sign a broad band
      ...(w.hand?.held?.kind === 'lantern'
        ? { x: w.hand.x, y: w.hand.y - 2, z: w.hand.z, radius: 40 }
        : w.lantern.onPost
          ? { x: PROPS.lantern.x + 3.3, y: 14, shadowY: 8, z: PROPS.lantern.z + 0.3, radius: 45 }
          : { x: w.lantern.x, y: 3 + w.lantern.y, z: w.lantern.z, radius: 40 }),
      color: [1.7 * fl, 1.1 * fl, 0.55 * fl] as Color,
      tail: 0.08,
      wobble: 0.5,
      shadows: true,
      seed: 3,
    })
  }
  // a burning stick in the visitor's hand (its flame, at the stick's tip), and any set down
  {
    const held = w.hand?.held
    if (w.hand && held?.kind === 'stick' && held.lit) {
      const fl = 0.8 + 0.2 * vnoise(t * 9, 11)
      const [tx] = stickTip(HELD_STICK)
      const s = ZOOM
      out.push({
        kind: 'carried',
        name: 'burning stick',
        x: w.hand.x + tx / s,
        y: w.hand.y + 4,
        z: w.hand.z,
        // it burns low before it goes out
        radius: 40 * Math.min(1, 0.45 + held.burn / 40),
        color: [1.9 * fl, 1.0 * fl, 0.42 * fl],
        wobble: 1,
        tail: 0.1,
        shadows: true,
        seed: 21,
      })
    }
    w.brands.forEach((b, i) =>
      out.push({
        kind: 'carried',
        name: `burning stick ${i}`,
        x: b.x + 2,
        y: 2 + b.y,
        z: b.z,
        radius: 30 * Math.min(1, 0.35 + b.burn / 40),
        color: warm((0.8 + 0.2 * vnoise(t * 9 + i, 12)) * 1.3),
        wobble: 1,
        tail: 0.05,
        shadows: true,
        seed: 22 + i,
      }),
    )
  }
  PROPS.graves.forEach((g, i) => {
    const c = w.candles[i]
    if (!c.lit) return
    const fl = (0.8 + 0.2 * vnoise(t * 7 + g.x, 2)) * (0.6 + 0.4 * c.wax)
    out.push({
      kind: 'candle',
      name: `candle ${i}`,
      x: g.x + 3,
      y: 3,
      z: g.z + 1,
      radius: 22,
      color: warm(1.2 * fl),
      wobble: 0.7,
      tail: 0.04,
      shadows: true,
      seed: g.x,
    })
  })
  PROPS.huts.forEach((h, i) => {
    if (hutOccupancy(w, i))
      out.push({
        kind: 'window',
        name: `hut ${i} window`,
        x: h.x + 3,
        y: 10,
        z: h.z + 3,
        radius: 18,
        color: warm(0.95),
        wobble: 0,
        tail: 0.04,
        shadows: false,
        seed: i,
      })
  })
  if (ren.runeOf(w) > 0.02) {
    const k = ren.runeOf(w)
    // the rune glows from inside the carving: a tight light at the cut, with a soft spill around it
    out.push({
      kind: 'rune',
      name: 'trigon rune',
      x: PROPS.trigon.x,
      y: 24,
      z: PROPS.trigon.z + 1.2,
      radius: 13,
      color: [0.2 * k, 1.0 * k, 0.95 * k],
      wobble: 0.1,
      tail: 0.09,
      shadows: false,
      seed: 11,
    })
  }
  for (const m of w.mush) {
    if (m.size < 0.5 || m.fsm.state === 'asleep') continue
    out.push({
      kind: 'cap',
      name: `${m.name}'s cap`,
      x: m.x,
      y: 6,
      z: m.z,
      radius: 8,
      color: [0.08, 0.3, 0.28],
      wobble: 0,
      tail: 0,
      shadows: false,
      seed: m.id,
      owner: tagId(`mush${m.id}`),
    })
    if (m.id === w.keeperId)
      out.push({
        kind: 'ember',
        name: `${m.name}'s ember`,
        x: m.x + (m.flip ? -3 : 3),
        y: 4,
        z: m.z,
        radius: 10,
        color: [0.75, 0.38, 0.12],
        wobble: 0.5,
        tail: 0,
        shadows: false,
        seed: m.id,
      })
    if (m.fsm.state === 'departing')
      out.push({
        kind: 'carried',
        name: `${m.name}'s lantern`,
        x: m.x + (m.flip ? -3 : 3),
        y: 5,
        z: m.z,
        radius: 15,
        color: warm(0.8),
        wobble: 0.6,
        tail: 0.03,
        shadows: false,
        seed: m.id,
      })
  }
  for (const s of SHROOMS)
    out.push({ kind: 'foxfire', name: 'foxfire', x: s.x, y: 1, z: s.z, radius: 7, color: [0.16, 0.1, 0.3], wobble: 0, tail: 0, shadows: false, seed: s.ph })
  for (const m of w.memorials)
    out.push({
      kind: 'glowcap',
      name: `${m.name}'s glowcap`,
      x: m.x,
      y: 3,
      z: m.z,
      radius: 13,
      color: [0.15, 0.6, 0.55],
      wobble: 0,
      tail: 0.03,
      shadows: false,
      seed: m.ph,
      owner: tagId(`glowcap${m.spot}`),
    })
  for (const f of w.flies)
    if (f.a > 0.05)
      out.push({
        kind: 'firefly',
        name: 'firefly',
        x: f.x,
        y: f.y,
        z: f.z,
        radius: 8,
        color: [0.5 * f.a, 0.6 * f.a, 0.2 * f.a],
        wobble: 0,
        tail: 0,
        shadows: false,
        seed: f.seed,
      })
  // in the hush, the forest's own lights reach a little further
  if (ren.hush > 0)
    for (const l of out)
      if (l.kind === 'cap' || l.kind === 'foxfire' || l.kind === 'glowcap' || l.kind === 'firefly')
        l.color = [l.color[0] * (1 + 0.8 * ren.hush), l.color[1] * (1 + 0.8 * ren.hush), l.color[2] * (1 + 0.8 * ren.hush)]
  // the editor's tuning, per kind of light
  return out.flatMap((l) => {
    const k = settings.lights[l.kind!]
    if (!k) return [l]
    if (!k.on) return []
    return [
      {
        ...l,
        y: l.y + k.height,
        shadowY: l.shadowY === undefined ? undefined : l.shadowY + k.height,
        radius: l.radius * k.radius,
        color: [l.color[0] * k.gain, l.color[1] * k.gain, l.color[2] * k.gain] as Color,
        wobble: l.wobble * k.wobble,
        tail: l.tail * k.tail,
        shadows: k.shadows === 'default' ? l.shadows : k.shadows === 'on',
      },
    ]
  })
}

/**
 * The moonlight, from where the moon is (its direction and height), its phase, and the clouds:
 * a full moon high overhead lights the most, a crescent near the trees the least, and cloud
 * over the moon itself dims it most of all.
 */
export function moonlight(ren: Renderer, w: World): MoonLight {
  const fam = DATA.families.moon
  const L = fam?.light ?? MOONLIGHT
  const at = ren.moonAt ?? moonPlace(w.moon)
  const phase = (at.phase * Math.PI) / 180
  const { x, y } = at
  const alt = clamp((HORIZON - y) / (HORIZON - 14 * RES)) // 0 on the treeline, 1 at the top of its path
  const across = Math.max(-1, Math.min(1, (x - stoneX()) / (35 * RES))) // -1 left of the window over the stone, 1 right
  const dir = unit(Math.sin((Math.PI / 2) * across), 0.2 + 0.8 * alt, -0.35)
  const lit = 0.15 + 0.85 * ((1 + Math.cos(phase)) / 2) // how much of the face is lit
  const k = at.up ? lit * (0.35 + 0.65 * alt) : 0 // behind the stone: only the fill
  const cloud = w.weather.cloud
  const clear = 1 - Math.max(0.75 * cloud, 0.9 * cloudAt(x, y, w.t, cloud))
  return {
    dir,
    half: unit(dir[0] + VIEW[0], dir[1] + VIEW[1], dir[2] + VIEW[2]),
    fill: L.fill + 0.15 * lit,
    key: L.key * k * clear,
    hl: L.highlights * k * clear,
    // faint, and fainter still when the moon is dim or clouded over
    shadow: at.up ? (L.shadows ?? MOONLIGHT.shadows) * Math.min(1, 0.4 + k) * clear : 0,
  }
}
