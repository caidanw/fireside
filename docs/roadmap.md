# Dark Forest: roadmap

Ideas and open work for `/lab/dark_forest`, roughly in priority order. Research notes live in `docs/research/`.

## Next

- **Shroomfolk art pass.** Bring the hut's tricks to the shroomfolk, who are on screen most: a lathe stem, the cap's warts as their own raised part, light textures. Then the knight, frog and crow redesigns.
- **Shape sliders for generated things** (the families view): crown size and lobes, trunk width, bush size and count, with the scene as the live preview.

## Smoothness

- ~~**Storm stutter.**~~ Fixed: a rising pool recolours only its own region (under 1 ms) instead of rebuilding the static layer.
- ~~**GPU uploads.**~~ Fixed: only the bands of rows that moving things touched (this frame or last) are restored from the still scene and uploaded; it used to be ~31 MB a frame.
- ~~**Shadow rebake stalls.**~~ Fixed: the moon's shadow rebake is spread over frames; point-light maps are kept per size, so the fire's flicker no longer rebakes them.
- **Headroom, measured** (Chrome, CPU throttling, 390×844 @3x): 60 fps at 4×, about 57 fps at 6× (draw ~8 ms + compose ~7 ms). A real phone test is still to do (touch, battery, thermal).
- **What's left to trim at the low end:** the per-pixel draw (~5 ms at 4×) and the per-frame light gathering. Not needed yet.
- **Sound's one-off costs.** About 4–8 ms on the main thread per log landing and per close thunder crack. Fine for now; they could move to idle time or an AudioWorklet.
- **Static rebuild** takes about 150 ms (on load, and while editing art or families). Only the editor feels it, when dragging sliders.

## Sound

- The full mix is judged good (an 8-minute night render with per-source levels is in `moodboard/sounds/night/`, tool `tools/night_render.ts`).
- **Parked:** leaf drops and pool drips (off by default). They sounded like pops and squeaks; they could get the research-and-measure treatment that fixed the crow, log and thunder.
- **A hummed melody for songs by the fire** (the song, dancing and floating notes exist; the sound doesn't yet).
- **Creature sounds:** the shroomfolk, knight, deer, bats and moths are silent. Candidates: soft footsteps on leaves and moss, the knight's armour, shroomfolk murmurs or humming, wingbeats as bats pass.

## Life that reads

- A visitor watching for a minute should catch a small story: readable poses and timing, small moments of focus, sounds for creatures.
- **Graded rain reactions:** creatures react to how hard it rains, not just to a 0.3 threshold.

## Night and time

- ~~**The moon.**~~ Done: it glides through the open sky over the clearing (10 minutes, a setting), sinks behind the trigon stone, which glows as it turns it, and the forest hushes (stars swell, its own lights glow brighter) until it rises in its next phase (8 phases a cycle). Moonlight is a real light (a cool fill, a soft overhead key, highlights on what faces the moon) following its place, phase and the clouds, with faint moon shadows.
- **Softer moonlight bands** if their slow creep (on hut caps and leaf clumps, as the moon moves) is noticeable.
- **A night arc:** dusk, deep night and the blue hour before dawn (mocked up roughly; parked until wanted). A full day is a bigger question.

## Look

- ~~**Soft 3/4.**~~ The ground is at about 28°; round things are drawn as seen from about 14° (a common pixel-art cheat for readable silhouettes): the hut, bushes, tree trunks and stumps. Flat things (graves, hearthstones, the trigon) stay as they are. Props can reach below their ground point (`foot`).
- ~~**The hut.**~~ Redrawn in soft 3/4: flat colours lit by normals, a warty bulb (lathe shape), striations, raised spot bumps, the arched door and an oval window as their own parts.
- ~~**Textures and depth.**~~ Per part and per family (stone, bark, leaves, fibre, wood, grain, striate, moss, cloth, craters), foliage depth (leaf clumps, painted depth, sheen), softer foliage highlights.
- Brighter, thinner small scenery where needed.
- The editor inspector shows a stale final colour on the GPU path.

## Editor

- The art editor has a parts brush (twin letters), part shapes (dome, cylinder, lathe, cap, under, flat), textures and relief, glow and set-back columns, and an in-the-scene preview. The families view tunes generated things and the moon.

## Shipping

- The work is on `experiment/dark-forest-sim`, unmerged and unpushed. Merge and deploy when ready; check loading time and browser coverage (WebGL2, falling back to the CPU path).
- Site fonts: `--font-mono` names ServerMono but nothing loads it, so visitors without it installed get a fallback monospace. Self-host it like Mekzantine if it matters.
