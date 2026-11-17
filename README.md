# Fireside

A cozy pixel-art simulation: a firelit clearing at night, where a last knight keeps his vigil and a
village of shroomfolk tends the fire. Hover to discover the story; click the ground to drop a stick.

Live at [fireside.caidan.dev](https://fireside.caidan.dev).

## Running it

```sh
npm install
npm run dev
```

Then open the page Vite prints. The editor is at `/editor` (dev server only): art, layout, lights,
sound and the generated families, saved through staging (`.staging/`) and applied from its Changes
tab. On the game page, `#debug` shows the inspector and the rendering keys.

`npm run build` type-checks and builds to `dist/`. Pushing to `main` deploys to GitHub Pages
(`.github/workflows/deploy.yml`; the domain is `public/CNAME`).

## Credits

MEKZANTINE (alpha v1), a pixel font by Michael Alexander (MEK.txt), self-hosted with permission.
