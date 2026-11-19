# Fireside: roadmap

Open work for Fireside (fireside.caidan.dev), roughly in priority order. Research notes are in
`docs/research/`; what's done is in the git history.

## Next

- **The world notices you.** The visitor can feed the fire and carry things, and the story mentions it once. Make their presence matter: shroomfolk gather to a light they carry (or follow it), one who's been dangled remembers them, the knight nods when they feed his fire.
- **The village remembers.** Each visit starts a fresh village. Keep it between visits (in localStorage): the same shroomfolk, the glowcaps of those who died, "a visitor returned".
- **The visitor's own sounds.** A log landing in the fire, a hiss in the pool, the lantern's clink on its hook.
- **The first 30 seconds.** After "sit by the fire", the world invites the hand in: the fire low and wanting a log, a stick glinting nearby, a shroomfolk glancing up.
- **Watch people play.** Two or three people, five minutes each, told nothing: where they get stuck or drift off is the real list.
- **Shroomfolk art pass.** Bring the hut's tricks to the shroomfolk, who are on screen most: a lathe stem, the cap's warts as their own raised part, light textures. Then the knight, frog and crow redesigns.
- **Shape sliders for generated things** (the families view): crown size and lobes, trunk width, bush size and count, with the scene as the live preview.
- **Small things:** the carried lantern's iron frame is too dark (its own light skips it); the crow sent off by the hand still says "off somewhere drier"; the editor's inspector shows a stale final colour on the GPU path.

## Phones and sharing

- **Performance on a real phone** (touch, battery, heat). In Chrome with the CPU slowed at 390×844 @3x: 60 fps at 4×, about 57 at 6× (draw ~8 ms, compose ~7 ms).
- **Turning end over end.** Held sideways, the scene goes on the notch's side, but an iPhone turned from one landscape to the other reports the same turn, so it stays where it was.
- **The X player card** plays inside posts on x.com; the X phone apps may open it in their browser instead. X's policy reserves player cards for audio and video, so it could stop. See `docs/research/x-player-card.md`.

## Smoothness

- **The low end:** the per-pixel draw (~5 ms at 4×) and the per-frame light gathering. Not needed yet.
- **Sound's one-off costs:** about 4–8 ms on the main thread per log landing and per close thunder crack. They could move to idle time or an AudioWorklet.
- **The static rebuild** takes about 150 ms (on load, and while editing art or families). Only the editor feels it, when dragging sliders.

## Sound

- The full mix is judged good (an 8-minute night render with per-source levels is in `moodboard/sounds/night/`, made with `moodboard/tools/night_render.ts`).
- **Parked:** leaf drops and pool drips (off by default). They sounded like pops and squeaks; they could get the research-and-measure treatment that fixed the crow, log and thunder.
- **A hummed melody for songs by the fire** (the song, dancing and floating notes exist; the sound doesn't yet).
- **Creature sounds:** the shroomfolk, knight, deer, bats and moths are silent. Candidates: soft footsteps on leaves and moss, the knight's armour, shroomfolk murmurs or humming, wingbeats as bats pass.

## Life and time

- A visitor watching for a minute should catch a small story: readable poses and timing, small moments of focus, sounds for creatures.
- **Graded rain reactions:** creatures react to how hard it rains, not just to a 0.3 threshold.
- **Softer moonlight bands,** if their slow creep (on hut caps and leaf clumps, as the moon moves) is noticeable.
- **A night arc:** dusk, deep night and the blue hour before dawn (mocked up roughly; parked until wanted).
- **The knight's last walk** (rising, walking to the grove, kneeling) is written but switched off (`LAST_WALK` in `src/sim/knight.ts`); his vigil is forever for now. It needs a kneel frame.
- Brighter, thinner small scenery where needed.
