/** What hovering names: the words for things, and the tags that say which thing a pixel belongs to. */
import { type DetailKind } from '../world'

/** What the small things are called on hover. */
export const DETAIL_NAMES: Record<DetailKind, [string, string]> = {
  fern: ['a fern', 'curled tight at the tips'],
  grass: ['tall grass', 'it whispers when the wind comes'],
  foxglove: ['foxgloves', 'pretty, and poisonous'],
  rock: ['a mossy stone', 'cold, even by the fire'],
  stump: ['an old stump', 'something lives inside'],
  log: ['a fallen log', 'soft with moss'],
  mushrooms: ['little mushrooms', "the village's cousins"],
}

/** What the bushes are called on hover. */
export const BUSH_NAMES: [string, string][] = [
  ['a bramble', 'thorny, and full of small sounds'],
  ['a holly bush', 'its leaves catch the firelight'],
  ['a thicket', 'something is asleep in there'],
  ['a juniper', 'it smells of rain'],
]

export const FONT = "ServerMono, 'Server Mono', ui-monospace, monospace"

/** How the campfire is burning, for its hover label. */
export const FIRE_WORDS: Record<string, string> = {
  embers: 'down to its embers',
  low: 'burning low',
  steady: 'burning steady',
  roaring: 'roaring',
  blazing: 'blazing, built high',
}

/** Break text into lines no wider than maxWidth (in the context's current font). */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > maxWidth) {
      out.push(line)
      line = word
    } else line = next
  }
  if (line) out.push(line)
  return out
}

/** The smallest a hover label's name is drawn on screen (CSS pixels; its lore is a little smaller). */
export const LABEL_MIN = 11

/** Stable ids for hover tags, by key ('knight', 'hut0', 'mush42'...). */
export const TAGS = new Map<string, number>()

export const TAG_KEYS = new Map<number, string>()

export function tagId(key: string): number {
  let id = TAGS.get(key)
  if (!id) {
    TAGS.set(key, (id = TAGS.size + 1))
    TAG_KEYS.set(id, key)
  }
  return id
}

export const STATE_WORDS: Record<string, string> = {
  arriving: 'new here, still finding their way',
  carried: 'up in the air, legs kicking',
  dizzy: 'set down, and a little dizzy',
  idle: 'pottering about',
  wander: 'pottering about',
  fetch: 'off to fetch a stick',
  haul: 'hauling a stick to the pile',
  feed: 'fetching a log for the fire',
  stoke: 'feeding the fire',
  toHut: 'heading home to rest',
  entering: 'going home to rest',
  exiting: 'up and about again',
  farewell: 'saying goodbye to the knight',
  departing: 'setting off down the road',
  wilting: 'going to rest in the quiet grove',
  tend: 'relighting the grove candles',
  visit: 'sitting with an old friend',
  keep: "keeping the fire, in the knight's place",
  sing: 'singing by the fire',
  join: 'bringing wood for the song',
  offer: 'throwing wood on the fire',
  dance: 'dancing round the fire',
}
