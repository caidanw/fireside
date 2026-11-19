/** Everything drawn each frame: the creatures, the fire, the wood, the lantern, what the visitor holds, and the glows and particles over them. */
import { SPRITES } from '../art/art'
import { CANDLE, HUT_DOOR, LOG, RELIC_ART, SKULL, STICK } from '../art/props'
import {
  CROW,
  CROW_PAL,
  DEER,
  DEER_PAL,
  DEER_PARTS,
  FROG,
  FROG_PAL,
  FROG_PARTS,
  GLOWCAP,
  GLOWCAP_PAL,
  GLOWCAP_PARTS,
  KEEPER_PALS,
  KEEPER_PARTS,
  KEEPER_SHINE,
  KNIGHT,
  KNIGHT_KNEEL,
  KNIGHT_NOD,
  KNIGHT_PAL,
  KNIGHT_PARTS,
  KNIGHT_SHINE,
  KNIGHT_STAND,
  KNIGHT_TOSS,
  MUSH,
  MUSH_KEEPER,
  MUSH_PALS,
  MUSH_PARTS,
  elk,
  type Rows,
} from '../art/sprites'
import { NOTE_LIFE, WALKING, doorOpen, hutOccupancy, isElder, isMoving, isRaining, lightRadius, perchPos, rainAmount, type Mush, type World } from '../sim'
import { TOSS } from '../sim/knight'
import { clamp, hash, rngFrom, vnoise, type Color } from '../util'
import { BUSHES, C, DETAILS, EYES, HEARTHSTONES, HORIZON, KNIGHT_GRAVE, PADS, PROPS, RES, SHROOMS, W, ZOOM, project, scaleAt, type Point } from '../world'
import { Buf, GROUND_DEPTH, SKY_DEPTH, copyBands, copyBuf } from './frame'
import { BUSH_NAMES, DETAIL_NAMES, FIRE_WORDS, STATE_WORDS } from './labels'
import { FLAME, FLASH, GLOW, inMoon } from './look'
import { shape, type Normal } from './materials'
import { partNormals, spriteNormals } from './normals'
import type { Renderer } from './renderer'
import { drawGrave, drawPoolEdge, drawSword } from './scenery'
import {
  BAT,
  CROWN_PX,
  HELD_STICK,
  NOTES,
  OWL,
  RELICS,
  SITTING,
  TRIGON_INSIDE,
  TRIGON_LIP,
  ZED,
  capOf,
  disc,
  hutChimney,
  hutOpenings,
  lanternCut,
  mushHop,
  owlTree,
  stickPixels,
  stickTip,
  trigonPx,
} from './shapes'
import { tickMoon } from './sky'

export function drawDynamic(ren: Renderer, w: World) {
  tickMoon(ren, w)
  restoreStill(ren)
  drawPoolEdge(ren, ren.fb, w.poolLevel)
  nameTheStill(ren, w)
  // objects first (they fill the depth buffer that the glows test against), then the glows
  const fire = drawFireside(ren, w)
  const glowcaps = drawGlowcaps(ren, w)
  const folk = drawShroomfolk(ren, w)
  const frog = drawCreatures(ren, w)
  drawGlows(ren, w, glowcaps, folk, frog)
  drawFlame(ren, w, fire)
  drawAir(ren, w, fire)
}

/** Back to the still scene, and an empty emissive layer: everywhere if the still layer changed, otherwise only the bands of rows last frame's moving things touched. */
function restoreStill(ren: Renderer) {
  const B = ren.fb
  if (ren.stillChanged) {
    copyBuf(B, ren.st)
    for (const k in ren.fx) ren.fx[k as keyof typeof ren.fx].fill(0)
    ren.fx.dep.fill(SKY_DEPTH)
    ren.fx.rdep.fill(SKY_DEPTH)
    ren.stillChanged = false
  } else {
    copyBands(B as never, ren.st as never, ren.touched)
    copyBands(ren.fx as never, ren.fxEmpty as never, ren.touched)
  }
  // what last frame touched still has to reach the GPU ren frame (it's been put back)
  ren.touchedBefore.set(ren.touched)
  ren.touched.fill(0)
  ren.frameNo++
  ren.shadows.dynamics = []
  ren.labels.clear()
  ren.tag = 0
  ren.region = 0
}

/** Names for the static props (their pixels were tagged when the static layer was built). */
function nameTheStill(ren: Renderer, w: World) {
  PROPS.huts.forEach((_, i) => {
    const sleepers = w.mush.filter((m) => m.fsm.state === 'asleep' && m.hut === i).map((m) => m.name)
    const sub = sleepers.length ? `${sleepers.join(' and ')} asleep inside` : doorOpen(w, i) ? 'someone is stepping through the door' : 'empty for now'
    ren.say(`hut${i}`, 'shroomfolk hollow', sub)
  })
  ren.say('lanternpost', 'the road out', w.lantern.onPost ? 'someone keeps the lantern lit' : 'its lantern has wandered off')
  ren.say(
    'lantern',
    'the lantern',
    w.hand?.held?.kind === 'lantern' ? 'warm in your hand' : w.lantern.onPost ? 'it lights the road out' : 'set down in the grass, still burning',
  )
  w.brands.forEach((b, i) => ren.say(`brand${i}`, 'a burning stick', b.burn > 20 ? 'it will burn a while yet' : 'nearly out'))
  ren.say('trigon', 'the trigon stone', ren.turning > 0.05 ? 'it is turning the moon' : w.rune > 0.1 ? 'it hums in the rain' : 'cold and quiet')
  ren.say('pack', 'his pack', w.knight.fsm.state === 'gone' ? 'left by the fire; nobody has moved it' : 'everything he still owns')
  // the hearthstones: whichever is carved says so; the others are just old
  const plain = ['older than the village', 'the tallest of them, and the oldest', 'it leans, as if listening']
  HEARTHSTONES.forEach((hs, i) =>
    hs.carved
      ? ren.say(
          `hearth${i}`,
          'the carved hearthstone',
          w.fire.heat > 0.55 ? 'its crown glows when the fire is high' : 'an antler crown, cut deep, like the one in the fire',
          true,
        )
      : ren.say(`hearth${i}`, 'a hearthstone', plain[i] ?? 'cold and old', true),
  )
  {
    const companions = w.knight.fsm.state === 'gone' ? 'the knight and his companions' : "the knight's companions"
    const village = w.memorials.length ? `, and ${w.memorials.length} of the village` : ''
    const candles = w.candles.some((c) => c.lit) ? '' : ' · the candles are out'
    ren.say('grove', 'the quiet grove', `${companions}${village}${candles}`)
  }
  ren.say('fire', 'the campfire', FIRE_WORDS[w.fire.fsm.state])
  ren.say('woodpile', 'woodpile', `${w.pile} log${w.pile === 1 ? '' : 's'}, stacked by small hands`)
  ren.say('pool', 'rain pool', w.poolLevel > 1.08 ? 'swollen with rain' : 'still and dark')
  ren.say('foxfire', 'foxfire', 'a fungus that glows on rotting wood')
  ren.say('relic', RELICS[ren.relic].name, RELICS[ren.relic].sub)
  BUSHES.forEach((b, i) => ren.say(`bush${i}`, ...BUSH_NAMES[b.seed % BUSH_NAMES.length]))
  DETAILS.forEach((d, i) => ren.say(`detail${i}`, ...DETAIL_NAMES[d.kind]))
  ren.say('undergrowth', 'the deep wood', 'it goes on further than anyone has walked')
  ren.say('owl', 'an owl', w.owl.away > 0 ? 'looking off into the dark' : 'it watches the fire with you')
  ren.say('fardeer', elk() ? 'an elk, far off' : 'a deer, far off', 'crossing the back of the wood')
  ren.say('bats', 'bats', 'out hunting moths')
}

/** The fire and what's about it, drawn as objects (the flame comes later, as light): the campfire, the relic, the wood, the lantern, what the visitor holds, the knight, sticks, the hut doors and the grove's candles. Returns where the fire is on screen. */
function drawFireside(ren: Renderer, w: World) {
  const B = ren.fb
  const [fireX, fireY] = ren.tagged('fire', () => drawCampfire(ren, B, w))
  const [, groundY] = project(0, 0, 0)
  ren.tagged('relic', () => drawRelic(ren, B, fireX, groundY))
  ren.tagged('woodpile', () => drawWoodpile(ren, B, w.pile))
  const held = w.hand?.held
  ren.heldKey = held?.kind === 'lantern' ? 'lantern' : held?.kind === 'folk' ? `mush${held.id}` : null
  ren.tagged('lantern', () => drawLantern(ren, B, w))
  w.brands.forEach((b, i) => ren.tagged(`brand${i}`, () => drawStick(ren, B, b.x, b.z, 0, 0.35 + i, b.y)))
  ren.tagged('held', () => drawHeld(ren, B, w))
  for (const l of w.tossed) ren.tagged('woodpile', () => drawStick(ren, B, l.x, l.z, 0, l.angle, l.y)) // the knight's log, on its way to the fire
  drawKnight(ren, B, w)
  w.sticks.forEach((s, i) => {
    ren.say(`stick${i}`, 'a stick', s.landed ? (s.claimed ? 'someone is coming for it' : 'waiting to be fetched') : 'falling')
    ren.tagged(`stick${i}`, () => (s.log ? drawLog(ren, B, s.x, s.z, s.y) : drawStick(ren, B, s.x, s.z, 0, s.angle, s.y)))
  })
  PROPS.huts.forEach((hut, i) => ren.tagged(`hut${i}`, () => drawHutDoor(ren, B, hut, doorOpen(w, i))))
  ren.tagged('grove', () =>
    PROPS.graves.forEach((g, i) => {
      const [gx, gy] = project(g.x + 3, 0, g.z + 1)
      // it burns down from the top: a stub of two rows, up to the art's full height
      const { rows, pal } = CANDLE
      const tall = Math.min(rows.length, 2 + Math.round(w.candles[i].wax * (rows.length - 2)))
      for (let r = 0; r < tall; r++)
        [...rows[rows.length - 1 - r]].forEach((ch, k) => ch !== '.' && ren.put(B, gx + k, gy - r, pal[ch], g.x + 3, g.z + 1, r / RES, gy, g.z + 2))
    }),
  )

  return { fireX, fireY, groundY }
}

/** Glowcaps, where shroomfolk returned to the soil (their glow is drawn later). */
function drawGlowcaps(ren: Renderer, w: World) {
  const B = ren.fb
  return w.memorials.map((m) => ({
    ...ren.sprite(B, GLOWCAP, m.x, m.z, GLOWCAP_PAL, false, {
      glow: SPRITES.glowcap.glow,
      parts: GLOWCAP_PARTS,
      hover: { key: `glowcap${m.spot}`, name: 'a glowcap', sub: `${m.name} rests here` },
    }),
    ph: m.ph,
    key: `glowcap${m.spot}`,
  }))
}

/** The shroomfolk (asleep ones are inside their hut). Returns what glows on them, drawn later: caps, travellers' lanterns, the keeper's ember. */
function drawShroomfolk(ren: Renderer, w: World) {
  const t = w.t
  const B = ren.fb
  const caps: { glow: [number, number, number][]; by: number; dep: number; elder: boolean; key: string }[] = []
  const lanterns: { x: number; y: number; dep: number; key: string }[] = []
  let keeperEmber: { x: number; y: number; dep: number; key: string } | null = null
  for (const m of w.mush) {
    const st = m.fsm.state
    if (st === 'asleep') continue
    const key = `mush${m.id}`
    const [name, sub] = mushHover(m, w)
    const hover = { key, name, sub }
    if (st === 'sprouting') {
      ren.sprite(B, m.size < 0.5 ? MUSH.baby : MUSH.mid, m.x, m.z, MUSH_PALS[capOf(m)], m.flip, { glow: SPRITES.shroomfolk.glow, hover, parts: MUSH_PARTS })
      continue
    }
    const keeper = w.keeperId === m.id
    const moving = WALKING.includes(st) && isMoving(m)
    const hop = mushHop(st, moving, t, m.seed, isRaining(w))
    const elder = isElder(m)
    const [, by] = project(m.x, 0, m.z)
    const sink = st === 'wilting' ? Math.round(m.sink * 10) : 0
    const cap = elder ? 'elder' : capOf(m)
    const pal = keeper ? KEEPER_PALS[cap] : MUSH_PALS[cap]
    // held up by the visitor's hand (and, once let go, dropping back down): world height to art pixels
    const air = ((m.air ?? 0) * scaleAt(m.z)) / RES
    const sp = ren.sprite(B, mushFrame(m, w, keeper), m.x, m.z, pal, m.flip, {
      glow: (keeper ? SPRITES.keeper : SPRITES.shroomfolk).glow,
      lift: hop - sink + air,
      sinkTo: sink ? by : undefined,
      hover,
      parts: keeper ? KEEPER_PARTS : MUSH_PARTS,
      shine: keeper ? KEEPER_SHINE : undefined,
    })
    caps.push({ ...sp, elder, key })
    if (m.carrying) ren.tagged(key, () => drawStick(ren, B, m.x, m.z, sp.h / RES + 1 + hop))
    if (st === 'departing') lanterns.push({ x: sp.bx + (m.flip ? -4 : 4) * RES, y: sp.by - 4 * RES, dep: sp.dep + 0.02, key })
    // the keeper carries an ember from the fire, so you can always find them, even in the dark
    if (keeper) keeperEmber = { x: sp.bx + (m.flip ? -4 : 4) * RES, y: sp.by - 3 * RES, dep: sp.dep + 0.02, key }
  }

  return { caps, lanterns, keeperEmber }
}

/** The deer, the frog, the elk far off, and the crow on its stone. Returns where the frog is (its croak glows later). */
function drawCreatures(ren: Renderer, w: World) {
  const t = w.t
  const B = ren.fb
  // deer
  const D = w.deer
  const ds = D.fsm.state
  const drows = ds === 'drink' ? DEER.drink : ds === 'graze' ? DEER.walk[0] : DEER.walk[((D.step * 5) % 2) | 0]
  const deerSub = ds === 'flee' ? 'startled' : ds === 'drink' ? 'drinking' : D.thirst > 1 ? 'thirsty' : 'grazing'
  ren.sprite(B, drows, D.x, D.z, DEER_PAL, D.flip, { hover: { key: 'deer', name: 'a deer', sub: deerSub }, parts: DEER_PARTS })

  // frog, mid-hop or sitting on its pad
  const F = w.frog
  const [ax, az] = PADS[F.from]
  const [bx2, bz2] = PADS[F.pad]
  const hopping = F.fsm.state === 'hop'
  const k = hopping ? F.progress : 1
  const frogX = ax + (bx2 - ax) * k
  const frogZ = az + (bz2 - az) * k
  const arc = hopping ? Math.round(Math.sin(k * Math.PI) * 4) : 0
  const frog = ren.sprite(B, FROG[hopping ? 1 : 0], frogX, frogZ, FROG_PAL, bx2 < ax, {
    lift: arc + 1,
    dep: frogZ + 1,
    hover: { key: 'frog', name: 'the frog', sub: 'unimpressed' },
    parts: FROG_PARTS,
  })

  // an elk far off, at the back of the wood (the mist takes most of it): drawn at the deer's
  // pixel scale, so far off it reads as huge. Until the elk is drawn, a deer walks there instead.
  if (w.farDeer) {
    const fd = w.farDeer
    const e = elk()
    const frame = ((fd.step * 3) % 2) | 0
    if (e?.frames.walk0 && e.frames.walk1)
      ren.sprite(B, frame ? e.frames.walk1 : e.frames.walk0, fd.x, fd.z, e.palettes.default, fd.dir < 0, {
        hover: { key: 'fardeer', name: 'an elk, far off', sub: 'crossing the back of the wood' },
        parts: e.parts,
        shine: e.shine,
      })
    else
      ren.sprite(B, DEER.walk[((fd.step * 4) % 2) | 0], fd.x, fd.z, DEER_PAL, fd.dir < 0, {
        hover: { key: 'fardeer', name: 'a deer, far off', sub: 'crossing the back of the wood' },
        parts: DEER_PARTS,
      })
  }

  // crow on the trigon stone (in flight it's drawn with the emissives, over the sky)
  const K = w.crow
  if (K.fsm.state === 'perch') {
    const [px, py] = perchPos()
    const lookLeft = t % 6 < 3
    ren.say('crow', 'a crow', 'it watches the fire too')
    ren.tagged('crow', () =>
      CROW[0].forEach((row, r) =>
        [...row].forEach((ch, c) => {
          if (ch !== '.')
            ren.put(B, px + (lookLeft ? 7 - c : c) - 4, py - 7 + r, CROW_PAL[ch] ?? C.crow, PROPS.trigon.x, PROPS.trigon.z, 40, py, PROPS.trigon.z + 1)
        }),
      ),
    )
  }

  return { bx: frog.bx, by: frog.by, dep: frog.dep, left: bx2 < ax }
}

/** The glows, depth-tested against everything drawn so far: caps, lanterns, embers, croaks, windows, the lantern's glass, burning sticks, the rune, candles, the carved crown, foxfire, glowcaps and eyes in the trees. */
function drawGlows(
  ren: Renderer,
  w: World,
  glowcaps: ReturnType<typeof drawGlowcaps>,
  { caps, lanterns, keeperEmber }: ReturnType<typeof drawShroomfolk>,
  frog: ReturnType<typeof drawCreatures>,
) {
  const t = w.t
  const glow = 1 + 0.7 * ren.hush // the forest's own lights glow brighter in the hush
  const F = w.frog
  const K = w.crow
  const R = lightRadius(w)
  const heat = w.fire.heat
  for (const cap of caps)
    ren.tagged(cap.key, () => {
      // an elder's warts have dimmed with age
      for (const [gx, gy, s] of cap.glow) ren.putFx(gx, gy, GLOW.cap, s * (cap.elder ? 0.53 : 1) * glow, cap.by, cap.dep + 0.01)
    })
  for (const l of lanterns)
    ren.tagged(l.key, () => {
      for (let dy = 0; dy < 3; dy++)
        for (let dx = 0; dx < 2; dx++) ren.putFx(l.x + dx, l.y + dy, GLOW.lantern[dy < 2 ? 0 : 1], dy < 2 ? 0.95 : 0.8, undefined, l.dep)
    })
  if (keeperEmber) {
    const e: { x: number; y: number; dep: number; key: string } = keeperEmber
    const pulse = 0.75 + 0.25 * Math.sin(t * 3)
    ren.tagged(e.key, () => {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) ren.putFx(e.x + dx, e.y + dy, GLOW.ember, pulse, undefined, e.dep)
      ren.putFx(e.x + (Math.sin(t * 9) > 0 ? 1 : 0), e.y - 1, FLAME[2], 0.6 * pulse, undefined, e.dep, 0.6)
    })
  }
  if (F.croak > 0)
    ren.tagged('frog', () => {
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) ren.putFx(frog.bx + (frog.left ? -4 : 2) + dx, frog.by - 5 + dy, GLOW.croak, 0.8, undefined, frog.dep + 0.01)
    })
  if (K.fsm.state === 'flying' || K.fsm.state === 'returning') {
    ren.say('crow', 'a crow', 'off somewhere drier')
    ren.tagged('crow', () =>
      CROW[1 + (((t * 8) % 2) | 0)].forEach((row, r) =>
        [...row].forEach((ch, c) => {
          if (ch !== '.') ren.putFx(K.x + c - 5, K.y + r - 2, CROW_PAL[ch] ?? C.crow, 1, undefined, PROPS.trigon.z + 1, 0) // it flies about as far off as the trigon
        }),
      ),
    )
  }
  PROPS.huts.forEach((hut, i) =>
    ren.tagged(`hut${i}`, () => {
      const [hx, hy] = project(hut.x, 0, hut.z)
      const asleep = hutOccupancy(w, i)
      const o = asleep || doorOpen(w, i) ? hutOpenings() : null
      // lamplight inside when someone's asleep; a dimmer glimpse of it through an open door
      if (o)
        for (const [dk, dr] of o.door) ren.putFx(hx + dk, hy - dr, GLOW.inside, o.light * (asleep ? 1 : 0.25 / 0.45), undefined, hut.z + o.inside + 0.1, 0.3)
      if (o && asleep) for (const [dk, dr, g] of o.window) ren.putFx(hx + dk, hy - dr, GLOW.window, g, undefined, hut.z + 0.05)
    }),
  )
  ren.tagged('lantern', () => {
    const at = ren.lanternAt
    if (!at) return
    const { lantern } = lanternCut()
    const fl = 0.75 + 0.25 * vnoise(t * 6, 7)
    const flame = Math.max(0, ...Object.values(lantern.glow))
    const h = lantern.rows.length
    lantern.rows.forEach((row, r) =>
      [...row].forEach((ch, c) => {
        const s = lantern.glow[ch]
        if (!s) return
        const up = h - 1 - r // the upper glass glows a touch differently from the lower (as on the post)
        ren.putFx(at.sx + c - lantern.anchor, at.sy - up, GLOW.lantern[s === flame ? 0 : up > 4 ? 2 : 1], fl * s, at.ground, at.dep + 0.05)
      }),
    )
  })
  // burning sticks: the one in the hand, and those set down
  const tip = brandTip(w)
  if (tip) ren.tagged('held', () => smallFlame(ren, tip[0], tip[1], tip[2], t, 1))
  w.brands.forEach((b, i) => {
    const [bx, by] = project(b.x, b.y, b.z)
    const [tx, ty] = stickTip(0.35 + i)
    ren.tagged(`brand${i}`, () => smallFlame(ren, Math.round(bx) + tx, Math.round(by) - 2 + ty, b.z + 0.1, t + i, b.burn / 30))
  })
  const rune = ren.runeOf(w)
  if (rune > 0.02)
    ren.tagged('trigon', () => {
      const p = PROPS.trigon
      const [bx, by, sc] = project(p.x, 0, p.z)
      const hy = by - Math.round(Math.round(40 * sc) * 0.6)
      const pulse = rune * (0.7 + 0.3 * Math.sin(t * 2))
      // light sits in the cut, radiates faintly from the face inside it, and haloes the lip around it
      for (const [dx, dy] of TRIGON_INSIDE) ren.putFx(bx + dx, hy + dy, GLOW.rune, 0.22 * pulse, undefined, p.z + 0.2, 0.4)
      for (const [dx, dy] of TRIGON_LIP) ren.putFx(bx + dx, hy + dy, GLOW.rune, 0.18 * pulse, undefined, p.z + 0.2, 0.6)
      for (const [dx, dy] of trigonPx) ren.putFx(bx + dx, hy + dy, GLOW.rune, pulse, undefined, p.z + 0.2)
    })
  ren.tagged('grove', () =>
    PROPS.graves.forEach((g, i) => {
      const [gx, gy] = project(g.x + 3, 0, g.z + 1)
      const c = w.candles[i]
      if (c.lit) {
        const top = gy - 2 - Math.round(c.wax * 4)
        const a = (0.7 + 0.3 * vnoise(t * 7 + g.x, 2)) * (0.6 + 0.4 * c.wax)
        ren.putFx(gx, top, GLOW.candle, a, gy, g.z + 2.05)
        ren.putFx(gx + (vnoise(t * 5 + g.z, 3) > 0.5 ? 1 : 0), top - 1, GLOW.candle, a * 0.8, gy, g.z + 2.05)
      }
    }),
  )
  // the crown carved into the tall hearthstone warms with the fire
  ren.tagged('hearth1', () => {
    const hs = HEARTHSTONES.find((h) => h.carved)
    if (!hs) return // no stone carved, nothing to warm
    const [bx, by, s] = project(hs.x, 0, hs.z)
    const cy = by - Math.round(Math.round(hs.h * s * 0.75) * 0.55)
    const warm = clamp((heat - 0.35) * 1.6)
    if (warm > 0.02) for (const [dx, dy] of CROWN_PX) ren.putFx(bx + dx, cy + dy, GLOW.carving, warm * (0.6 + 0.2 * Math.sin(t * 1.5)), undefined, hs.z + 0.1)
  })
  // foxfire: faint violet specks on rotten wood (ambient, just pretty)
  ren.tagged('foxfire', () => {
    for (const s of SHROOMS) {
      const [sx, sy] = project(s.x, 0, s.z)
      const a = 0.4 + 0.25 * Math.sin(t * 0.8 + s.ph)
      for (const [dx, dy, d] of [
        [0, 0, 0],
        [1, 0, 0],
        [3, -1, 1],
        [-2, 1, 1],
        [2, 1, 1],
      ])
        ren.putFx(sx + dx, sy + dy, d ? GLOW.foxfireD : GLOW.foxfire, a * (d ? 0.7 : 1) * glow, sy, s.z + 0.05, 0.6)
    }
  })
  // glowcap caps (the mushrooms themselves are drawn with the objects)
  for (const g of glowcaps)
    ren.tagged(g.key, () => {
      const pulse = 0.75 + 0.25 * Math.sin(t * 0.6 + g.ph)
      for (const [gx, gy, s] of g.glow) ren.putFx(gx, gy, GLOW.memorial, pulse * s * glow, g.by, g.dep + 0.01)
    })
  EYES.forEach((e, i) => {
    const d = Math.hypot(e.x, e.z)
    if (d < R * 1.05 || (t * 0.7 + e.ph) % 4 < 0.12) return // they keep to the dark, and blink
    const [sx, sy] = project(e.x, e.y, e.z)
    const a = 0.8 * clamp((d - R * 1.05) / 15)
    ren.say(`eyes${i}`, 'something in the trees', 'watching the fire')
    ren.tagged(`eyes${i}`, () => {
      for (const dx of [0, 1, 4, 5]) ren.putFx(sx + dx, sy, GLOW.eye, a, undefined, e.z)
      for (const dx of [2, 3]) ren.putFx(sx + dx, sy, GLOW.eye, 0.01, undefined, e.z, 0) // invisible bridge, so the gap between them hovers too
    })
  })
}

/** The fire's flame and coals, and the glow of the relic's carving between the flame's two sheets. */
function drawFlame(ren: Renderer, w: World, { fireX, fireY, groundY }: ReturnType<typeof drawFireside>) {
  const t = w.t
  const heat = w.fire.heat
  // The flame is a volume: two translucent sheets curved around the middle of the fire, like
  // a cylinder. The back sheet (deep reds, slower) curves away from the camera, the front
  // one (golds, faster, more see-through) bulges toward it, its base dipping into the near
  // side of the stone ring. Each pixel's depth follows the curve, so the relic stands inside
  // the fire, the logs show through it, and anyone in front of the ring still covers it.
  // The front sheet is light added on top: where the sheets overlap the fire burns hotter.
  // Size follows the fire's heat, so a fresh log swells it gradually.
  const flame = (front: boolean) => {
    const side = front ? 1 : -1
    const half0 = (front ? 3 + 5 * heat : 2.6 + 4.4 * heat) * RES
    const fh = (front ? 4 + 18 * heat : 5 + 23 * heat) * RES
    const dip = front ? 5 : 3 // how far the base curves toward (or away from) the camera, in pixels
    const seed = front ? 31 : 0
    const xr = Math.ceil(half0 + 4 * RES)
    for (let x = fireX - xr; x <= fireX + xr; x++) {
      const ub = (x - fireX) / half0
      const baseY = fireY + Math.round(side * dip * Math.sqrt(Math.max(0, 1 - ub * ub)))
      for (let y = Math.floor(baseY - fh - 2); y <= baseY; y++) {
        const dy = (baseY - y) / fh
        if (dy > 1 || dy < 0) continue
        const sway = Math.sin(t * (front ? 3.6 : 2.6) + dy * 4 + seed) * dy * 2.5 * RES
        const half = half0 * Math.pow(1 - dy, 0.7) + 0.5
        const n = front ? vnoise((x / RES) * 0.5 + seed, (y / RES) * 0.45 + t * 8.5) : vnoise((x / RES) * 0.36, (y / RES) * 0.32 + t * 6)
        const v = (1 - Math.abs(x - fireX - sway) / half) * (1 - dy * 0.6) + (n - 0.5) * 0.9 - dy * 0.35
        if (v < 0.12) continue
        const u = Math.max(-1, Math.min(1, (x - fireX - sway) / half))
        const depth = side * (0.3 + 4 * Math.sqrt(1 - u * u) * (1 - dy))
        const k = front ? (v > 0.7 ? 3 : v > 0.45 ? 2 : 1) : v > 0.75 ? 2 : v > 0.4 ? 1 : 0
        const a = front ? 0.22 + 0.45 * clamp(v) : 0.55 + 0.4 * clamp(v)
        ren.putFx(x, y, FLAME[k], a, groundY, depth, front ? 0.22 : 0.18, front)
      }
    }
  }
  ren.tagged('fire', () => {
    // a bed of coals in the middle of the ring, flickering pixel by pixel
    const coals = (3 + 3 * Math.min(1, heat)) * RES
    disc((px, py) => ren.putFx(px, py, FLAME[hash(px, py * 3 + ((t * 8) | 0)) < 0.5 ? 1 : 2], 1, groundY, (py - fireY) * 0.8, 0.3), fireX, fireY + 2, coals, 3)
    flame(false)
  })
  // The relic itself is drawn with the objects (drawRelic), lit like them; between the two flame
  // sheets, the back one hides behind it and the front one licks over it. Its carving glows with
  // the fire's heat on top (the bone/wood itself doesn't).
  ren.tagged('relic', () => {
    const art = RELIC_ART[ren.relic]
    const h = art.rows.length
    const wd = art.rows[0].length
    const warm = clamp(heat * 1.1 - 0.15)
    if (warm > 0.02)
      art.rows.forEach((row, r) =>
        [...row].forEach((ch, c) => {
          const glows = art.glow[ch] ?? 0
          if (glows) ren.putFx(fireX + c - (wd >> 1), groundY + r - h, GLOW.carving, warm * (0.6 + 0.3 * vnoise(t * 3, c + r)), groundY, 0.01, glows * warm)
        }),
      )
  })
  ren.tagged('fire', () => flame(true))
}

/** What moves in the air: glowing mushrooms, fireflies, moths, bats, the owl, lightning, smoke, embers, sleepers' z's, notes, flies, shooting stars, falling sticks, dust and ripples. */
function drawAir(ren: Renderer, w: World, { fireX, fireY, groundY }: ReturnType<typeof drawFireside>) {
  const t = w.t
  const glow = 1 + 0.7 * ren.hush // the forest's own lights glow brighter in the hush
  const heat = w.fire.heat
  // little glowing mushrooms about the wood
  for (const g of ren.detailGlows) {
    ren.tag = g.tag
    ren.putFx(g.x, g.y, GLOW.memorial, (0.35 + 0.25 * Math.sin(t * 0.7 + g.ph)) * glow, undefined, g.dep, 0.5)
  }
  ren.tag = 0
  // fireflies deep in the trees
  for (const f of w.farFlies) {
    if (f.a <= 0.02) continue
    const [px, py] = project(f.x, f.y, f.z)
    ren.putFx(px, py, GLOW.firefly, f.a * 0.8 * glow, undefined, f.z, 0.8)
  }
  // moths about the fire and the lantern
  for (const m of w.moths) {
    if (m.y < 0) continue
    const [px, py] = project(m.x, m.y, m.z)
    ren.putFx(px, py, C.moth, 0.85, undefined, m.z + 0.5, 0)
    if (Math.sin(t * 40 + m.seed * 9) > 0) ren.putFx(px + 1, py, C.moth, 0.5, undefined, m.z + 0.5, 0)
  }
  // bats across the sky (behind the trees)
  ren.tagged('bats', () => {
    for (const b of w.bats) {
      const frame = BAT[Math.sin(b.ph) > 0 ? 0 : 1]
      frame.forEach((row, r) =>
        [...row].forEach((ch, c) => ch !== '.' && ren.putFx(b.x + (b.vx > 0 ? c : 4 - c) - 2, b.y + r - 1, C.bat, 1, undefined, SKY_DEPTH / 2, 0)),
      )
    }
  })
  // the owl on its branch: a dark shape, and its eyes (blinking, and now and then turned away)
  const ot = owlTree()
  if (ot) {
    const [ox, oy] = project(ot.x + ot.w * 0.9, 24, ot.z)
    ren.tagged('owl', () => {
      // it stands on its bottom row, one pixel below the perch point; its eyes shut when it blinks or looks away
      const rows = OWL.frames.perch
      const pal = OWL.palettes.default
      const eyes = w.owl.away <= 0 && w.owl.blink > 0
      rows.forEach((row, r) =>
        [...row].forEach((ch, c) => {
          if (ch === '.') return
          const [dx, dy] = [c - (row.length >> 1), r - (rows.length - 2)]
          const g = OWL.glow[ch] ?? 0
          if (!g) ren.putFx(ox + dx, oy + dy, pal[ch], 1, undefined, ot.z + 0.05, 0)
          else if (eyes) ren.putFx(ox + dx, oy + dy, GLOW.eye, g, undefined, ot.z + 0.06, 0.6)
        }),
      )
    })
  }
  // a lightning bolt, far off behind the trees (sky depth: everything stands in front of it)
  const bolt = w.weather.bolt
  if (bolt) {
    const a = (1 - bolt.age / 0.4) * (Math.sin(bolt.age * 90) > -0.3 ? 1 : 0.35)
    const rng = rngFrom(bolt.seed)
    const strand = (x0: number, y0: number, y1: number, k: number, depth: number) => {
      let x = x0
      for (let y = y0; y < y1; y++) {
        if (y % 3 === 0) x += Math.round((rng() - 0.5) * 4)
        ren.putFx(x, y, [0.92, 0.95, 1], a * k, undefined, SKY_DEPTH / 2, 1)
        ren.putFx(x + 1, y, FLASH as Color, a * k * 0.4, undefined, SKY_DEPTH / 2, 1)
        // now and then a branch
        if (depth < 2 && rng() < 0.04) strand(x, y, Math.min(y1, y + 10 + rng() * 25), k * 0.6, depth + 1)
      }
    }
    strand(bolt.x, 8 * RES, HORIZON + 2, 1, 0)
  }
  // smoke when the fire is low or it's raining (steam)
  const smoky = clamp((0.5 - heat) * 1.4) + rainAmount(w) * 0.45
  if (smoky > 0.02) {
    for (let i = 0; i < 10; i++) {
      const age = (t * 0.35 + i / 10) % 1
      const sx = fireX + ((vnoise(i * 3.1, t * 0.4) - 0.5) * 8 * age + Math.sin(t + i) * age * 3) * RES
      const sy = fireY - (6 + age * 34) * RES
      const rad = 1 + Math.round(age * 2)
      disc((px, py) => ren.putFx(px, py, GLOW.smoke, smoky * 0.12 * (1 - age), undefined, 0.3, 0), Math.round(sx), Math.round(sy), rad, rad)
    }
  }
  for (const e of w.embers) {
    const life = 1 - e.age / e.life
    ren.putFx(fireX + e.ox * RES, groundY - e.oy * RES, [1, (120 + life * 100) / 255, 60 / 255], life, groundY, 0.2, 0.6)
  }
  for (const z of w.zs) {
    const hut = PROPS.huts[z.hut]
    const [hx, hy] = project(hut.x, 0, hut.z)
    const [cx, cy] = hutChimney()
    const zx = Math.round(hx + (cx + z.age * 3) * RES)
    const zy = Math.round(hy - (cy + z.age * 6) * RES)
    for (const [dx, dy] of ZED) ren.putFx(zx + dx, zy + dy, GLOW.zzz, 0.7 * (1 - z.age / 1.8), undefined, hut.z + 0.05, 0.4)
  }
  for (const n of w.notes) {
    // up from the singer's head, swaying a little, fading as they go
    const [nx, ny] = project(n.x + Math.sin(n.age * 2.5 + n.sway) * 1.6, 13 + n.age * 4.5, n.z)
    const a = 0.85 * Math.min(1, n.age * 4) * (1 - n.age / NOTE_LIFE)
    for (const [dx, dy] of NOTES[((n.sway * 10) % 2) | 0]) ren.putFx(Math.round(nx) + dx, Math.round(ny) + dy, GLOW.note, a, undefined, n.z - 0.1, 0.5)
  }
  for (const f of w.flies) {
    if (f.a <= 0.02) continue
    const [px, py] = project(f.x, f.y, f.z)
    ren.putFx(px, py, GLOW.firefly, f.a * glow, project(f.x, 0, f.z)[1], f.z)
  }
  if (w.shooting) {
    const s = w.shooting
    for (let i = 0; i < 8; i++) {
      const x = s.x + (s.age * 120 - i * 2) * RES
      const y = s.y + (s.age * 40 - i * 0.66) * RES
      // only across open sky: never over the distant treeline, the ridges or the moon
      const j = Math.round(y) * W + Math.round(x)
      if (y < HORIZON && x >= 0 && x < W && ren.st.sky[j] && !inMoon(x, y)) ren.putFx(x, y, GLOW.star, (1 - i / 8) * (1 - s.age / 0.9), undefined, SKY_DEPTH)
    }
  }
  // a stick you just dropped carries a soft highlight, so you can see where it went
  w.sticks.forEach((s, i) => {
    if (s.glint <= 0.02) return
    const [bx, by] = project(s.x, s.y, s.z)
    ren.tagged(`stick${i}`, () => {
      for (const [dx, dy] of stickPixels(s.angle)) ren.putFx(bx + dx, by - 1 + dy, GLOW.glint, 0.55 * s.glint, undefined, s.z + 0.65, 0.25)
    })
  })
  // falling sticks cast a small shadow that tightens as they near the ground; landings kick up dust
  for (const s of w.sticks) {
    if (s.landed) continue
    const [gx, gy] = project(s.x, 0, s.z)
    const spread = Math.max(1, Math.round(3 - s.y / 10)) * RES
    for (let dx = -spread; dx <= spread; dx++) ren.putFx(gx + dx, gy, C.char, 0.45 * (1 - s.y / 30), undefined, s.z - 0.1, 0)
  }
  for (const p of w.puffs) {
    if (p.age < 0) continue
    const k = p.age / 0.9
    const [gx, gy] = project(p.x, 0, p.z)
    for (let i = 0; i < 4; i++) {
      const ox = (hash(p.seed, i) - 0.5) * 9 * (0.3 + k) * RES
      const oy = (-k * 4 - hash(i, p.seed) * 2) * RES
      for (let dx = 0; dx < 2; dx++) ren.putFx(gx + ox + dx, gy + oy, GLOW.dust, 0.55 * (1 - k), undefined, p.z + 1, 0)
    }
  }
  for (const r of w.ripples) {
    if (r.age < 0) continue
    const a = r.age / 0.7
    const hw = ((1 + a * 4) | 0) * RES
    for (let dx = -hw; dx <= hw; dx++) ren.putFx(r.x + dx, r.y, GLOW.ripple, 0.55 * (1 - a), undefined, GROUND_DEPTH, 0.2)
  }
}

/** The lantern: on its post, in the visitor's hand (hanging from it), or set down somewhere. */
function drawLantern(ren: Renderer, B: Buf, w: World) {
  const { lantern, dx, up } = lanternCut()
  const h = lantern.rows.length
  const hand = w.hand
  if (hand?.held?.kind === 'lantern') {
    const [hx, hy] = project(hand.x, hand.y, hand.z)
    const [, gy] = project(hand.x, 0, hand.z)
    ren.lanternAt = { sx: Math.round(hx), sy: Math.round(hy) + h - 1, ground: gy, dep: hand.z + 0.6 }
  } else if (w.lantern.onPost) {
    const [lx, ly] = project(PROPS.lantern.x, 0, PROPS.lantern.z)
    ren.lanternAt = { sx: Math.round(lx) + dx, sy: Math.round(ly) - up, ground: ly, dep: PROPS.lantern.z + 0.01 }
  } else {
    const [, gy] = project(w.lantern.x, 0, w.lantern.z)
    const [lx, ly] = project(w.lantern.x, w.lantern.y, w.lantern.z) // (falling, once let go)
    ren.lanternAt = { sx: Math.round(lx), sy: Math.round(ly), ground: gy, dep: w.lantern.z }
  }
  const at = ren.lanternAt
  const wx = hand?.held?.kind === 'lantern' ? hand.x : w.lantern.x
  const wz = hand?.held?.kind === 'lantern' ? hand.z : w.lantern.z
  // not a shadow caster: its own light is inside it (a caster is a flat cut-out standing at its foot)
  const lift = hand?.held?.kind === 'lantern' ? hand.y : w.lantern.onPost ? up / ZOOM : w.lantern.y
  ren.drawArtNow(B, lantern, wx, wz, { at: [at.sx, at.sy], dep: at.dep, lift })
}

/** A single log, `height` above the ground (one set down by the visitor, or falling from their hand). */
function drawLog(ren: Renderer, B: Buf, wx: number, wz: number, height: number) {
  const [bx, by] = project(wx, height, wz)
  ren.drawArt(B, LOG, wx, wz, { at: [Math.round(bx), Math.round(by)], dep: wz + 0.6, lift: height })
}

/** What the visitor's hand holds (the lantern and shroomfolk are drawn with their own). */
function drawHeld(ren: Renderer, B: Buf, w: World) {
  const hand = w.hand
  const held = hand?.held
  if (!hand || !held) return
  const [hx, hy] = project(hand.x, hand.y, hand.z)
  if (held.kind === 'log') ren.drawArt(B, LOG, hand.x, hand.z, { at: [Math.round(hx), Math.round(hy) + 2], dep: hand.z + 0.6, lift: hand.y }) // held through its middle
  if (held.kind === 'stick') drawStick(ren, B, hand.x, hand.z, 0, HELD_STICK, hand.y) // a little slanted, like a torch
}

/** The tip of a stick held upright at the hand (screen), where its flame burns. */
function brandTip(w: World): [number, number, number] | null {
  const hand = w.hand
  const held = hand?.held
  if (!hand || held?.kind !== 'stick' || !held.lit) return null
  const [hx, hy] = project(hand.x, hand.y, hand.z)
  const [tx, ty] = stickTip(HELD_STICK)
  return [Math.round(hx) + tx, Math.round(hy) - 2 + ty, hand.z + 0.7]
}

/** A small flame (a burning stick's), flickering, at a screen point. */
function smallFlame(ren: Renderer, x: number, y: number, dep: number, t: number, size: number) {
  const k = (n: number) => FLAME[Math.min(3, Math.max(0, n))]
  const sway = Math.sin(t * 11) > 0.3 ? 1 : 0
  const tall = size > 0.5 ? 2 : 1
  ren.putFx(x, y, k(3), 0.95, undefined, dep, 0.9)
  ren.putFx(x - 1, y, k(2), 0.8, undefined, dep, 0.8)
  ren.putFx(x + 1, y, k(2), 0.8, undefined, dep, 0.8)
  for (let i = 1; i <= tall; i++) ren.putFx(x + (i === tall ? sway : 0), y - i, k(2 - i + 1), 0.85, undefined, dep, 0.8)
  ren.putFx(x + sway, y - tall - 1, k(0), 0.6, undefined, dep, 0.6)
}

/** A campfire on the ground: an ash bed with a few bones, logs leaning in. Returns the flame's base. */
function drawCampfire(ren: Renderer, B: Buf, w: World): [number, number] {
  const [fx, fy] = project(0, 0, 0)
  const heat = w.fire.heat
  // the ash bed lies flat (no reflection, no normals)
  disc(
    (px, py) => ren.put(B, px, py, hash(px * 7, py * 3) < 0.35 ? C.ashD : C.ash, (px - fx) / (1.35 * RES), (py - fy) / (0.6 * RES), 0.1, fy, -0.6, true),
    fx,
    fy,
    7 * RES,
    2 * RES,
  )
  // a few bones scattered in the ash, and a little skull at its edge
  for (const [dx, dy] of [
    [-12, 0],
    [9, 2],
    [-6, 2],
    [11, -2],
  ]) {
    for (let k = 0; k < 4; k++) ren.put(B, fx + dx + k, fy + dy, k === 0 || k === 3 ? C.boneD : C.bone, (dx + k) / 2.7, dy, 0.3, fy, -0.5, true)
    ren.put(B, fx + dx, fy + dy - 1, C.bone, dx / 2.7, dy, 0.4, fy, -0.5, true)
    ren.put(B, fx + dx + 3, fy + dy + 1, C.boneD, (dx + 3) / 2.7, dy, 0.2, fy, -0.5, true)
  }
  ren.drawArt(B, SKULL, -3.5, 0, { at: [fx - 9, fy + 1], dep: -0.4 })
  // logs leaning into the middle, charred toward the heart of the fire
  const logs: [number, number, number, number][] = [
    [-14, 2, -2, -6],
    [14, 2, 2, -6],
    [-8, 4, 2, -4],
    [8, 4, -2, -4],
  ]
  for (const [x0, y0, x1, y1] of logs) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const px = Math.round(x0 + (x1 - x0) * t)
      const py = Math.round(y0 + (y1 - y0) * t)
      for (let j = 0; j < 2; j++) {
        const c = t > 0.6 ? C.char : t > 0.3 || j === 1 ? C.log : C.logLit
        ren.put(B, fx + px, fy + py + j, c, px / 2.7, 0.2, (-py - j) / RES + 1, fy, 0.05)
        if (t > 0.55 && hash(px * 3 + j, py + ((w.t * 3) | 0)) < 0.5) ren.putFx(fx + px, fy + py + j, GLOW.ember, 0.4 + 0.6 * heat, fy, 0.06, 0.4)
      }
    }
  }
  return [fx, fy - 3 * RES]
}

function drawWoodpile(ren: Renderer, B: Buf, n: number) {
  const p = PROPS.woodpile
  const [bx, by] = project(p.x, 0, p.z)
  const slots = [
    [-4, 0],
    [0, 0],
    [4, 0],
    [-2, 2],
    [2, 2],
    [0, 4],
    [-6, 0],
    [6, 0],
    [4, 2],
  ]
  for (let i = 0; i < n; i++) {
    const [ox, oy] = slots[i]
    ren.drawArt(B, LOG, p.x + ox / 1.35, p.z, { at: [bx + ox * RES, by - oy * RES], dep: p.z + 0.001 * oy })
  }
}

/** A stick: lying flat, carried, or tumbling through the air (`height` above the ground, `angle` of its spin). */
function drawStick(ren: Renderer, B: Buf, wx: number, wz: number, lift: number, angle = 0, height = 0) {
  const [bx, by] = project(wx, height, wz)
  const [, gy] = project(wx, 0, wz)
  const cy = by - Math.round(lift * RES) - 1
  for (const [dx, dy, ch] of stickPixels(angle))
    ren.put(B, bx + dx, cy + dy, STICK.pal[ch], wx, wz, height + lift - dy / RES, gy, wz + 0.6, false, shape.cylinder(0))
}

/** Closed: a plank door with iron bands and a brass ring. Open: nothing, so the dark interior (and anyone passing through) shows. */
function drawHutDoor(ren: Renderer, B: Buf, hut: Point, open: boolean) {
  if (open) return
  const [bx, by] = project(hut.x, 0, hut.z)
  const { k0, r0 } = hutOpenings()
  const { rows, pal, parts, shine } = HUT_DOOR
  // its parts (if it has any) give it normals, and its texture (planks) with them
  const nm = parts.length ? partNormals(rows, parts, pal) : null
  rows.forEach((row, i) =>
    [...row].forEach((ch, c) => {
      if (ch === '.') return
      const k = k0 + c
      const r = r0 + rows.length - 1 - i
      const src = nm ? (i + 2) * nm.w + c + 2 : 0
      const nrm: Normal | undefined = nm ? [nm.nx[src], nm.ny[src], nm.nz[src]] : undefined
      ren.put(B, bx + k, by - r, pal[ch], hut.x, hut.z, r / RES, by, hut.z + 0.005, false, nrm, 0, 0, shine?.[ch] ?? 0) // its iron can gleam
    }),
  )
}

function mushHover(m: Mush, w: World): [string, string] {
  const st = m.fsm.state
  if (st === 'sprouting') return [m.name, 'a sprout, new since the rain']
  let words = STATE_WORDS[st] ?? ''
  if (st === 'visit' && m.spot !== null && w.memorials[m.spot]) words = `sitting by ${w.memorials[m.spot].name}'s glowcap`
  const name = w.keeperId === m.id ? `${m.name}, the keeper` : isElder(m) && st !== 'departing' && st !== 'wilting' ? `old ${m.name}` : m.name
  return [name, words]
}

/** The knight, as far along his story as he is. */
function drawKnight(ren: Renderer, B: Buf, w: World) {
  const k = w.knight
  const st = k.fsm.state
  const sitting = st === 'resting' || st === 'nodding' || st === 'tending'
  // seated, he holds his sword (it's in his sprite); it stays planted there when he gets up
  if (k.sword === 'planted' && !sitting) {
    ren.tagged('sword', () => drawSword(ren, B, PROPS.sword))
    ren.say('sword', 'his sword', 'he has not drawn it in a long time')
  }
  if (k.sword === 'laid') {
    // his grave, beside his companions': a cairn, his sword planted, his helm on the hilt
    ren.tagged('knightgrave', () => drawGrave(ren, B, { ...KNIGHT_GRAVE, helm: true }, 1))
    ren.say('knightgrave', 'the last knight', 'he rests with them now')
  }
  if (st === 'gone') return
  const sub: Record<string, string> = {
    resting: 'keeping his vigil',
    nodding: 'nodding off',
    tending: 'tending the fire',
    rising: 'rising, slowly',
    walking: 'walking to the quiet grove',
    kneeling: 'laying down his sword',
  }
  const opts = { hover: { key: 'knight', name: 'the last knight', sub: sub[st] }, shine: KNIGHT_SHINE, parts: KNIGHT_PARTS }
  if (sitting) {
    // tending the fire: he reaches to the pile, lifts a log, throws it
    const t = k.fsm.time
    const tend = t < TOSS.take ? KNIGHT_TOSS.reach : t < TOSS.throw ? KNIGHT_TOSS.lift : KNIGHT_TOSS.throw
    const rows = st === 'tending' ? tend : st === 'nodding' && k.headDown ? KNIGHT_NOD : KNIGHT
    ren.sprite(B, rows, k.x, k.z, KNIGHT_PAL, false, opts)
  } else if (st === 'kneeling') ren.sprite(B, KNIGHT_KNEEL, k.x, k.z, KNIGHT_PAL, false, opts)
  else ren.sprite(B, st === 'walking' ? KNIGHT_STAND[((k.step * 3) % 2) | 0] : KNIGHT_STAND[0], k.x, k.z, KNIGHT_PAL, k.flip, opts)
}

/**
 * The relic planted in the middle of the fire: an object like the others, so every light (the
 * fire round it, the moon over it) lights it through its normals. Those come from its parts, or
 * if it has none, rounded from its silhouette, so each tine reads as a little round bone.
 */
function drawRelic(ren: Renderer, B: Buf, fireX: number, groundY: number) {
  // it's drawn at the fire's middle (so the flame sheets wrap it), but lit as if it stood a little
  // behind the fire's light: the flames in front of it light its face, as they would
  const RELIC_LIGHT_Z = -1.5
  const art = RELIC_ART[ren.relic]
  const h = art.rows.length
  const wd = art.rows[0].length
  const s = project(0, 0, 0)[2]
  const nm = art.parts.length ? partNormals(art.rows, art.parts, art.pal) : spriteNormals(art.rows, (ch) => art.pal[ch])
  art.rows.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (ch === '.') return
      const k = c - (wd >> 1)
      const src = (r + 2) * nm.w + c + 2
      ren.put(
        B,
        fireX + k,
        groundY + r - h,
        art.pal[ch],
        k / s,
        RELIC_LIGHT_Z,
        (h - r) / s,
        groundY,
        0,
        false,
        [nm.nx[src], nm.ny[src], nm.nz[src]],
        0,
        0,
        art.shine[ch] ?? 0,
      )
    }),
  )
}

/** Which frame a shroomfolk shows: walking, standing, or sitting (with the occasional blink). */
function mushFrame(m: Mush, w: World, keeper: boolean): Rows {
  const set = keeper ? MUSH_KEEPER : isElder(m) ? MUSH.elder : MUSH
  const st = m.fsm.state
  const moving = WALKING.includes(st) && isMoving(m)
  if (moving) return set.walk[((w.t * (isElder(m) ? 5 : 7)) % 2) | 0]
  if (st === 'dance') return set.walk[((w.t * 6 + m.seed * 3) % 2) | 0] // stepping in time
  if (st === 'carried') return set.walk[((w.t * 9) % 2) | 0] // legs kicking in the air
  if (SITTING.includes(st)) return (w.t * 0.8 + m.seed * 7) % 3.5 < 0.15 ? set.sitBlink : set.sit
  return set.walk[0]
}
