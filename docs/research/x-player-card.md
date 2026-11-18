# The scene inside a post on X (the player card)

How Fireside plays inside a post on X, and what limits it. Researched November 2026.

## How it works

X has a **player card**, made for video players in 2014. When a posted link's page declares one, X
shows its image with a play button; pressing play loads a URL of the page's choosing in an iframe
inside the post. The iframe takes any HTTPS page, which is how the recent "Minecraft in a tweet"
(Tweetcraft), Doom, Flappy Bird and multiplayer Pong embeds work.
([antics.gg](https://antics.gg/blog/embed-game-in-x-post),
[Rosebud](https://rosebud.ai/engineering/making-rosebud-games-playable-in-x-posts),
[Taras Shynkarenko](https://tarasshynkarenko.com/skills/x-player-card))

The tags go on the page that's posted (X's crawler reads the served HTML, so they must be in it):

```html
<meta name="twitter:card" content="player" />
<meta name="twitter:player" content="https://fireside.caidan.dev/embed/" />
<meta name="twitter:player:width" content="640" />
<meta name="twitter:player:height" content="360" />
<meta name="twitter:image" content="https://fireside.caidan.dev/card-player.png" />
```

Title and description fall back to `og:title` and `og:description`. `twitter:site` (the poster's
handle) is listed as required but cards render without it. The image is the still shown before
play: same shape as the player, at least 262×262 worth of pixels, under 5 MB, not SVG.

## In Fireside

- **The home page carries the player card**, so posting `fireside.caidan.dev` plays the scene in the
  post. A page gets one `twitter:card`; the home page's `og:image` still serves iMessage, Slack and
  the like. Discord also reads `twitter:card` to choose a large image, so there it may show the
  smaller thumbnail.
- **`/embed/`** is what X frames: the scene alone (`embed/index.html`, `src/embed.ts`), filling
  the frame, running at once (X has already shown the still and a play button), silent until its
  sound button is pressed, with a link that opens the full site in a new tab.
- **`card-player.png`** is the still: the clearing at 2×, 1280×720.

## The frame's limits

X frames the player with
`sandbox="allow-popups allow-same-origin allow-scripts allow-presentation"` and
`allow="autoplay; fullscreen; web-share"`. So no forms, no pointer lock, no `alert()`/`confirm()`,
no navigating the X tab (links need `target="_blank"`), and sound only after a click inside the
frame. Fireside's embed needs none of the missing ones.

X sizes the frame to the timeline, smaller than the declared size (a 480×640 request came out
381×381 on desktop), so the embed fits whatever box it gets. Hover labels have a minimum on-screen
size (`LABEL_MIN` in `renderer.ts`) so they stay readable in a small frame, and on phones.

The page must be frameable by X: no `X-Frame-Options`, and no CSP `frame-ancestors` that leaves
X out. GitHub Pages sends neither, so X can frame it (and so can anyone else; Pages can't set
headers to restrict that).

## Caveats

- **Policy.** X's published player card policy reserves the card for "linear audio and video
  consumption only" and lists gaming among what not to build. Fireside is mostly something to
  watch, but it is interactive. X decides which links get the player and can stop showing it, so
  the post then falls back to the still image, and the link still opens the full site.
- **Phones.** X's docs say its iPhone and Android apps show a player card as its image and open the
  player URL in the in-app browser on tap; recent reports disagree. Only desktop x.com is known
  to play it inline.
- **Caching.** X caches a card per URL. If a post shows a stale card, post `fireside.caidan.dev/?v=2`.
- **No preview tool.** X's Card Validator no longer previews (since August 2022). Test by posting
  from a spare account; `curl -A "Twitterbot/1.0" https://fireside.caidan.dev/` shows what the
  crawler reads.

## Testing locally

`moodboard/tools/x/mock-x.html` frames `/embed/` with X's sandbox at two timeline sizes: build,
copy it into `dist/`, serve `dist/`, and open it.
