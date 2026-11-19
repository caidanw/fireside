# Fireside

A cozy pixel-art simulation: a firelit clearing at night, where a last knight keeps his vigil and a
village of shroomfolk tends the fire. Hover to discover the story; click and drag to carry things.

Live at [fireside.caidan.dev](https://fireside.caidan.dev). Posted on X, the link plays the scene
inside the post ([how](docs/research/x-player-card.md)).

## Running it

```sh
npm install
npm run dev
```

The site is at `/`, and the editor (art, layout, lights, sound; dev server only) at `/editor`.
`npm run build` type-checks and builds to `dist/`. Pushing `main` deploys to GitHub Pages.

- `npm run smoke [seed]` runs a night without a browser and prints a fingerprint of its frames:
  the same before and after a change means no pixel changed.
- `npm run share-images` renders the link preview and the icons from the scene (after art changes).

## Where things are

- `pages/`: the site, the scene alone for X (`embed/`) and the editor: their HTML, styles and icons.
- `src/sim/`: the world, its creatures small state machines.
- `src/render/`: draws the world at 640×360 and lights it, with one lighting model for every light.
- `src/audio/`: every sound, synthesised live with WebAudio.
- `src/data/`: the art, layout, lights and sound, as the editor saves them.
- `src/engine/`, `src/page/`: starting the scene, and the scripts of the page around it.
- `docs/`: the roadmap, and research notes.

## Credits

MEKZANTINE (alpha v1), a pixel font by Michael Alexander (MEK.txt), self-hosted with permission.

© Caidan Williams. All rights reserved.
