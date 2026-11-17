# AGENTS.md

## Boundaries

- Never push, merge or deploy without being asked: pushing `main` deploys to fireside.caidan.dev.
- Art and layout live in `src/data/*.json` and are the operator's to edit in the editor. Propose
  changes by staging them: write the whole file to `.staging/<file>.json` with `formatData()`
  from `src/editor/staging-plugin.mjs`. Keep whatever else is staged, and check the operator hasn't
  edited a staged entry before you replace it. Write `src/data/` directly only when asked to apply.
- When the operator applies staged data, commit it on its own as "… (applied in the editor)".
- Sounds the operator has accepted are not retuned without asking. Sound is WebAudio synthesis only.

## Conventions

- One lighting model for every light (fire, moon, lanterns): objects get normals (sprite and prop
  `parts`) and are lit by the renderer. Never paint lighting into art or fake it with emissive colour.
- Design questions get a mockup first, rendered in the real scene. Images go to `moodboard/shots/`
  (gitignored; open them for the operator, never leave them in `/tmp`). Reference images go in
  `moodboard/refs/`: inspiration only, never committed or copied into the art.
- No new test suites. Checks: `npm run check`, `npm run build`, `npx prettier --check .`.

## Traps

- `clamp()` in `src/util.ts` only clamps to 0..1.
- Headless renders: bundle with `npx -y esbuild@0.24 <file> --bundle --platform=node --format=esm --loader:.json=json`;
  dynamic import paths must be string literals or esbuild leaves them unbundled.
- The editor is the dev server's `/editor` page (`editor.html`, `src/editor/main.ts`); the site's build
  leaves it out. Its saves go through the staging API in `src/editor/staging-plugin.mjs`.
- Browser checks: test the built `dist/` (not the dev server, which can reach staging), with audio
  muted (`--mute-audio`); close only the sessions and servers you started.
