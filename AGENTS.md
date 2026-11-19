# AGENTS.md

## Boundaries

- Never push, merge or deploy without being asked: pushing `main` deploys to fireside.caidan.dev.
- Art and layout live in `src/data/*.json` and are the operator's to edit in the editor. Propose
  changes by staging them: write the whole file to `.staging/<file>.json` with `formatData()`
  from `src/editor/staging-plugin.mjs`. Keep whatever else is staged, and check the operator hasn't
  edited a staged entry before you replace it. Write `src/data/` directly only when asked to apply.
- Commits are Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`…), with no
  project prefix in the subject.
- When the operator applies staged data, commit it on its own, ending the subject with "(applied in
  the editor)", e.g. `feat(art): the elk's antlers (applied in the editor)`.
- Sounds the operator has accepted are not retuned without asking. Sound is WebAudio synthesis only.

## Conventions

- One lighting model for every light (fire, moon, lanterns): objects get normals (sprite and prop
  `parts`) and are lit by the renderer. Never paint lighting into art or fake it with emissive colour.
- Design questions get a mockup first, rendered in the real scene. Images go to `moodboard/shots/`
  (gitignored; open them for the operator, never leave them in `/tmp`). Reference images go in
  `moodboard/refs/`: inspiration only, never committed or copied into the art.
- No new test suites. Checks: `npm run check`, `npm run build`, `npx prettier --check .`.
- A change that shouldn't alter a pixel (a rename, a move, a split): `npm run smoke` before and
  after must print the same fingerprint.

## Traps

- `clamp()` in `src/util.ts` only clamps to 0..1.
- The pages (`pages/`) are Vite's root, and name their code `/src/...` (an alias in `vite.config.ts`).
- Scripts that use the game's code run through `node scripts/run.mjs <script.ts>`;
  `scripts/headless.ts` gives a seeded world and the renderer's CPU path.
- Browser checks: test the built `dist/` and the dev server (some bugs show in only one), with
  audio muted (`--mute-audio`); close only the sessions and servers you started.
- Phone layouts are the media blocks at the end of `src/page/page.css`. To see them, emulate touch
  over CDP (`Emulation.setTouchEmulationEnabled`): agent-browser's device setting alone doesn't
  make `(pointer: coarse)` match.
- `/embed/` runs inside X's sandboxed frame: no forms, `alert()`/`confirm()`, pointer lock or
  top-level navigation; links open in a new tab.
