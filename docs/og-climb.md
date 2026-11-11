# Climb OG share cards (`GET /og/climb`)

The backend renders the Open Graph card crawlers fetch when someone shares a
climb link. It moved here from the Vercel-hosted web route because Vercel
lambdas paid a cold-start + render cost (~1s TTFB, worse when idle) on every
CDN miss, and platforms like Facebook drop embeds that respond slowly.

## Endpoint

```
GET https://ws.boardsesh.com/og/climb
  ?board_name=kilter          # enum: kilter|tension|moonboard|decoy|touchstone|grasshopper|soill|woods
  &layout_id=1
  &size_id=10
  &set_ids=1,20               # canonicalised (sorted + deduped) by the zod schema; max 24 ids
  &frames=p1080r15p1202r12    # fully determines the image — no DB involved
  &format=jpeg                # optional; jpeg (default) | png | webp
  &n=BING+BANG+BOSH           # optional; climb name, <=64 code points after normalising
  &g=7a/V6                    # optional; grade label, [A-Za-z0-9+/. -]{1,16}
  &s=Patrick+Gosling          # optional; setter, <=32 code points after normalising
  &angle=40                   # optional; -90 to 90 (Grasshopper's list starts at -5)
```

The `set_ids` cap is 24 (`MAX_SET_IDS`), sized against the catalogue rather
than guessed: the widest shipped config is Decoy layout 2 / size 1 at 19 hold
sets. `set-ids-catalogue.test.ts` walks every entry in `SETS` and fails if one
outgrows the cap — when it was 10, every Decoy climb's card and board image was
a 400, and nothing caught it because both apps render the overlay locally and
never call this endpoint.

### The climb-identity column

The card is 1200x630 and is drawn on the share-card family's `full` slot (see
"The share-card family" below), the same grid as the playlist, profile and setter
cards: the board right-aligned in a 544x602 box at x 16-560, the climb's identity
in a column from x 590, and the BOARDSESH wordmark with its right edge at x 1160.
Both halves matter for different consumers — a social unfurl shows the whole
card, while a search engine crops it to a square from the centre and keeps only
`x` in [285, 915]. The grade is the hero, in its grade colour, and it always ends
inside that crop: it is one line, shrunk to fit and never cut or wrapped, so
`8C+/V16` and `7c+/V10` read whole at 110px. Under it come the climb name (bold,
up to three lines, truncated past that), the setter, and the board line with the
angle (`Kilter · 12 x 12 with kickboard · 40°`). `og-geometry.test.ts` walks the
catalogue and fails if a board leaves the art slot or the widest grades leave the
crop.

Before PR 5 of the family work the board sat in a 736x602 box with a 392px column
whose grade started at x 784, so `7a/V6` ran to about x 977 and the crop cut it.
The move shrank wide boards (Tension 16 wide, Kilter 1477x1200) by up to 36% and
pulled every board 200px left; the grade is what the crop keeps now.

`n`, `g`, `s` and `angle` are all **optional**, so a URL built by an
already-shipped mobile binary still renders. Its card leads with the board's
brand (`Kilter`) over the rest of the board line. With no grade the name leads
instead. The board line (`Kilter · Original · 12 x 12 Square`) is derived from
`board_name`/`layout_id`/`size_id`, not taken as a param: those already
determine the board that gets drawn, so a caller-supplied label would be a
second, forgeable source for the same fact.

The grade's colour is the grade scale's own (`getGradeColor`), lifted by the
family's `liftGradeColorForCard` until it clears contrast on `#181225`. V10 and up
are near-black purples on the scale and used to vanish into the old card's field.

### Why a card's holds look bolder than the app's

A card is authored at 1200x630 and almost nobody sees it at that size. Cropped
square and rendered at ~110px, the board is roughly 68px wide and an individual
hold about two pixels, at which point the app's drawing of a lit hold disappears
into the board art. So `isOgVariant` draws its marks bigger —
`OG_HOLD_SHAPE_EMPHASIS` x1.6, stroke x1.3, glow reach x1.4, all in
`render-config.ts`. Measured on a Kilter climb (sparse lit holds on a busy grey
board), the lit holds go from 68 to 160 vivid pixels in that thumbnail.

Switching the card to the thumbnail mark style (`glow-fill`) looks like the
obvious lever and is not: it measured +5.8% on Kilter and slightly negative on
MoonBoard, because the problem at 110px is the marks' size, not their style.

The emphasis survived the move to the family grid unchanged. The card's Aura config is one of the terms in `BOARD_RENDER_VERSION`
(`wasm_config_aura_card`). Before that it was not, and the projection asserted
that output width was "all the variants change in the config" — true until the
emphasis existed. Without the probe, a change here would move no version and
Cloudflare would serve the old drawing `immutable` for a year.

Ascents and quality are deliberately **not** on the card. They tick constantly,
and the response is immutable for a year, so every tick would mint a fresh cache
entry and leave the old one at the edge.

**Three things to know before touching the text path.**

1. **Every string must be escaped for Pango markup.** libvips calls
   `pango_parse_markup` unconditionally — there is no plain-text mode — so an
   unescaped `&` throws `text: invalid markup in text` rather than rendering
   literally. A climb called "Rock & Roll" would be a 500. `escapePangoMarkup`
   in `validation.ts` is the only safe way in. Every share card draws text through
   one function, `renderRaster` in `og-family.ts`; `og-card.ts` only decides what
   the climb card says.
2. **The card names its font family, and that is load-bearing.** On Alpine
   `fc-match sans` resolves to WenQuanYi Zen Hei — the CJK font — which renders
   Latin in its own weaker glyphs and does not honour `weight="700"`, so the
   grade and the climb name come out un-bold. `OG_CARD_FONT_FAMILY` defaults to
   `Noto Sans`; fontconfig still falls back to Zen Hei per character for CJK.
   Invisible in dev, because macOS resolves whatever the host has.
3. **The image needs fonts installed.** `Dockerfile.backend` is `node:22-alpine`,
   which ships none, and Pango does not degrade gracefully without them: a 40pt
   request renders 12px tall, Cyrillic comes back blank, and CJK throws. The
   image installs `fontconfig font-noto font-noto-emoji font-noto-hebrew
   font-wqy-zenhei` — sized against what real climb names contain, which includes
   Japanese katakana, Chinese and emoji. `font-wqy-zenhei` covers CJK for 27 MB
   where `font-noto-cjk` costs 90 MB for a visually identical result.

`n` and `s` are the only caller-supplied free text on the endpoint, which is
unauthenticated. They are NFC-normalised, stripped of control characters and of
the invisible/bidi-override set, whitespace-collapsed, and truncated by code
point. `OG_CARD_TEXT_DISABLED=1` drops both; the board, grade and angle keep
rendering. It is read once at module load, so it takes a restart to apply —
faster than shipping a code change, but not a live toggle.

Responses are immutable (`Cache-Control: … immutable`, 1 year): the query
fully determines the bytes. Invalid params are rejected with 400 before any
render CPU runs; per-IP rate limit is 120/min (fails open to the in-memory
limiter when Redis is down). `Server-Timing` breaks down wasm/base/encode ms
and reports the cache outcome (`hit` | `base-hit` | `miss`).

### Render-mode params (issue #2202)

Optional, shared with the web `/api/internal/board-render` route via
`boardseshRenderQuerySchema` (`@boardsesh/board-render`). `render_mode` defaults
to `aura`, the drawing the app has shipped since 2.4; the rest default closed.
Every option that affects the output is part of the byte-cache key, so an aura
render can never be served under a classic key. The base cache is keyed only by
board config because overlay options do not change its board photo backdrop.

**Every Boardsesh catalogue caller sends `render_mode` and `field_color` explicitly**, even
though the endpoint would default to them. The query string is the Cloudflare
cache key and a card is cached `immutable` for a year, so a response already at
the edge under a bare URL cannot be re-drawn in place — changing the drawing has
to change the URL. The default is for the callers we do not control: a store
binary from before the change that prewarms a bare URL, and any third party
embedding the endpoint.

`v` is the generated `BOARD_RENDER_VERSION`, sent by both web and mobile URL
builders, including spray-wall previews and share prewarming. It is a cache
alias, not a rendering option; older unversioned URLs remain accepted. The version
also hashes the shared bokeh engine and grain texture, the Sharp adapter, the
text drawing (`og-card.ts` and the family grid `og-family.ts`), the grade colours
and the spray compositor, so visual changes get new CDN URLs. The board line's
words (`BOARD_TYPE_LABELS`, layout and size names) are catalogue data rather than
code, so the projection records the line itself for every catalogue entry
(`og_board_line`, from `og-board-line.ts`): renaming a size moves the version.

The version is one string for every board and every image this backend draws, so
anything hashed into it turns over every climb card and every `/render/board`
thumbnail URL at once, even where the bytes did not change. That is why the
blocks only the other family cards draw (avatar, monogram, JOIN pill, recap dots,
profile bars) live in `og-family-blocks.ts`, which is not hashed; a test fails if
the climb card ever asks for one of them. The stack layout that places those
blocks is still in `og-family.ts`, because one function places every row the
climb card draws as well.

### Reusable frosted backdrop

Share cards use the same frosted bokeh as the player's lit board button. The
pure `@boardsesh/frosted-bokeh` package owns point mapping, falloff, intensity,
surface presets and the existing grain texture. Native draws those blobs with
`FrostedBokeh`; `@boardsesh/board-render/frosted-bokeh` draws them through Sharp.
Neither adapter duplicates the geometry or imports the other platform's renderer.

The board's lit holds turn clockwise into a maximum of 15 soft coloured blobs
on the full 1200×630 field. The card uses the dark surface with 5% white frost
and 3% still grain. Its OG-only preset scales blur/radii from a 225px reference
and draws the blobs at 45% opacity, for broad colour behind the actual lit holds.
The native control retains its original 8% frost, 6% grain and strength. Catalogue cards use
the overlay's selected screen palette and effective frame. Board photos, hold
marks, framing and text sit above the bokeh. With no usable points, the field
keeps its neutral frost and grain.

Over the bokeh goes the family scrim (`buildOgFamilyScrim('full')`): a 40% tint of
`#181225` across the card, then a 240px ramp into a 92% column from x 590. The
bokeh is quieter than it was under the old card's 90% column-only scrim; that is
the family look, the same on every card. The grade is up to 96pt, the name 34pt;
supporting labels and the wordmark clear 4.5:1 even over crowded white bokeh.

An `aura` render here draws exactly what the app draws. The look's tuning —
glow reach, the seam crossfade, the veil buckets, the fill alpha — lives in
`@boardsesh/board-look` and is applied by `buildAuraRenderFields`, which the
mobile native path and this pipeline both call with the board name. Woods receives
a 1.2 reach multiplier, composed with the saved setting, in both paths. The per-hold half (traced
silhouettes, LED plates, silhouette lightness) is read per board config from
`@boardsesh/board-art-geometry`; a config the tracer skipped still renders, with
every hold glowing a ring at its placement radius.

| Param          | Default   | Meaning                                                                                                                                       |
| -------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `render_mode`  | `aura`    | `aura` (veil + glow on traced silhouettes — the app's own drawing) or `classic` (the marker-only overlay).                                  |
| `glow_falloff` | `soft`    | `aura` mode only: glow edge treatment, `soft` or `plateau`.                                                                                 |
| `glyphs`       | off       | `aura` mode only: `0`\|`1`\|`true`\|`false` — role glyphs inside the glow.                                                                   |
| `field_color`  | unset     | `#rrggbb`: the play field the veil washes the unlit wall toward. Unset means the light field, on which every board's wall is darker than the field, so `veilOpacityFor` turns the veil off. www and the share cards send `#181225`, the dark field the app's play view composites over. |

## How a render works

Implementation: `packages/backend/src/services/board-render.ts` +
`src/handlers/og-climb.ts`, on top of the shared `@boardsesh/board-render`
package (`packages/shared/board-render`). The same backend service also serves
in-app images at `/render/board` and the compatibility alias
`/api/internal/board-render`.

1. WASM (`@boardsesh/board-renderer-wasm`) renders the hold overlay — eagerly
   initialised at server boot, so requests never pay init. If boot init failed
   (transient I/O), requests re-attempt init at most every 30s; until it
   succeeds the endpoint returns 503.
2. The board photos and framing are composited onto a transparent 1200×630 plane once per board config
   and cached as raw RGBA (**OG base cache**, LRU, 8 entries by default). The
   fallback preview config for every supported board is pre-warmed after boot.
   Warmups share the render cap but use a low-priority queue, so queued request
   work takes the next available slot between board warmups.
3. The climb-specific frosted backdrop and the family scrim are drawn underneath
   that cached plane; the hold overlay and text are composited above it and
   encoded — JPEG by default (mozjpeg, quality 85, 4:4:4 chroma). Alpine renders on
   the family grid were 61–106KB.
4. Final bytes land in the **byte cache** (LRU, 32MB by default), so repeat
   fetches (FB, Twitter, WhatsApp, Slack each fetch independently) are served
   from memory.

Before the frosted backdrop, steady-state timings were ~250ms for a new climb on a warm board config, ~0ms for
repeats, ~700ms worst-case first render of a never-seen board config.

## Env vars

| Var                        | Default               | Meaning                                                                                                                                                                            |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOARD_IMAGES_ROOT`        | `<cwd>/../web/public` | Directory containing `images/` (board photos). The backend Docker context ships `packages/web/public/images` via `extraSourceDirs` in `scripts/create-service-docker-context.mjs`. |
| `OG_CARD_FONT_FAMILY` | `Noto Sans` | the family handed to Pango; see the font note above |
| `OG_CARD_TEXT_DISABLED` | unset | `1` drops the caller-supplied `n`/`s`; read at module load, so it needs a restart |
| `BOARD_RENDER_CONCURRENCY` | `2`                   | Shared concurrency cap for OG and board-image misses, including low-priority boot warmups.                                                                                         |
| `BOARD_RENDER_MAX_QUEUE`   | `40`                  | Maximum unique render misses waiting behind the shared semaphore before a `503` with `Retry-After: 5`.                                                                             |

## Cache prewarming (why the endpoint sees browser-initiated hits)

Crawlers scrape seconds after a share, so clients prime the caches ahead of
them: climb view SSR fire-and-forgets one OG render per page view (via
`scheduleOgImageWarming`), and the Share button fetches ahead of the unfurler
before opening the share sheet. All best-effort — failures are swallowed and
never delay sharing.

**Mobile warms the card the page advertises, not one it builds.** The app cannot
reproduce the URL www puts in `og:image`: that angle is `selectCanonicalClimbAngle`,
chosen from every angle's ascent counts, so the same climb served at `/25/`,
`/40/` and `/50/` all advertise `angle=40`. A URL without the identity params is
a different key at Cloudflare *and* in `byteCache` — measured against production,
the app-shaped URL came back `MISS` while www's came back `HIT`, so the old
prewarm was heating something nobody requests.

So `prewarmShareCaches` (`packages/mobile/src/lib/share-prewarm.ts`) does two
things at once. It issues the identity-free URL immediately, which shares the
per-board `ogBase` with the real card and turns its render from `miss` into
`base-hit`. In parallel it fetches the share page, reads `og:image` out of the
head, and warms that exact URL. The page read is bounded (4s) so a request that
never answers cannot strand the rest, and only `BACKEND_URL` is ever followed —
a prewarm that chased any `og:image` it was handed would be a request forwarder.

This only warms the colo nearest the sharer. iMessage builds its preview
on-device so that is the right one; Slack and Discord fetch from their own
datacenters and still land cold.

## Operational notes

- Winston logs one line per render: `[OGClimb] served` with
  `{ boardName, layoutId, sizeId, cache, totalMs, wasmMs, encodeMs, bytes, format }`;
  renders over 1s log at `warn`.
- A missing images directory logs an error at boot and cards render
  backdrop-only (no board photo) rather than failing.
- Quick prod check:
  `curl -o /dev/null -s -w 'code=%{http_code} ttfb=%{time_starttransfer}s\n' 'https://ws.boardsesh.com/og/climb?board_name=kilter&layout_id=1&size_id=10&set_ids=1,20&frames=p1080r15p1202r12'`

## Cloudflare edge layer

`ws.boardsesh.com` is fronted by the Cloudflare proxy so og images edge-cache
globally (distant clients and the iOS share sheet fetch from a nearby colo
instead of the single-region Railway origin). The zone config, the apply
tooling (`vp run cf:apply`), token setup, CI auto-apply, and the rollback
runbook all live in **`docs/cloudflare.md`**.

- Web points `og:image` here via `buildOgBoardRenderUrl`
  (`packages/web/app/components/board-renderer/util.ts`), which derives the
  backend origin from `NEXT_PUBLIC_WS_URL`.

## Spray walls (`board_name=spray`)

A spray-wall card is the one response on this endpoint the query string does not
determine. Every catalogue board's backdrop ships in the repo and its hold
positions come from generated constants; a wall has neither. Its background is a
photograph in object storage and its holds live in `spray_wall_holds`, so
`GET /og/climb?board_name=spray&layout_id=…&frames=…` is answered from the
database — `packages/backend/src/services/spray-og-card.ts`, reached from a
branch in `handlers/og-climb.ts` that runs before the WASM availability check
(no WASM is involved, so a renderer that failed to boot must not 503 it).

**Public walls only.** A wall that is private, unlisted, soft-deleted, has never
published a version, or has no `public_photo_key` gets a 404, and every one of
those answers is the same 404 with the same body. The gates all run before a
single photo byte is read. Unlisted is not an exception: an unlisted wall is
reachable by uuid inside the app because the uuid is a capability the reader
holds, and a crawler fetching an OG image holds nothing — "hard to guess" would
be the whole access control.

**404, never 403.** Layout ids are sequential and this URL is guessable, so any
answer other than "there is nothing here" — a 403, a generic board card, a
different error shape — tells a stranger which ids are somebody's home wall.
A private wall and a nonexistent one are indistinguishable from outside.

**The 404 is never cached** (`Cache-Control: no-store`). A wall its owner makes
public tomorrow must not stay a 404 at the edge, and a cached negative on a
shareable URL is exactly the failure this document and the sitemap doctrine both
warn about.

**The 200 is daily, not `immutable`.** Every other card here carries a year of
`immutable` because its bytes follow from the query. A wall's do not: a reset
re-points the photograph and rewrites the holds under an unchanged `layout_id` +
`frames`, so an immutable header would pin last year's wall at the edge with no
URL left to change. `createOgImageHeaders({ version: null, unversionedTier:
'daily' })` gives it a day of freshness and a week of stale-while-revalidate.
The in-process byte cache is keyed on the wall's published version AND its photo
key, because a reset moves the version while the key may not and a
demote-then-re-promote mints a new random key while the version does not.

**The photo is the public copy, never a presigned URL.** Wall photos live in the
`private` bucket behind 15-minute signatures (`docs/spray-walls.md`, "Photo
privacy"). An unfurler cannot hold a signature and this card is cached for a day,
so the only thing this path will fetch is the world-readable `media` copy SW-14
writes when a wall is promoted to public.

**It shares the render cap.** `BOARD_RENDER_CONCURRENCY` is the cap for "OG and
board-image misses", and a wall's card is another miss: sharp decoding and
compositing a phone photograph is the same kind of work as the WASM overlay, so
it queues in the same semaphore (`runOnRenderSemaphore`) rather than a second
one that would double the real concurrency. A saturated queue answers the same
`503` + `Retry-After: 5` the catalogue path does. The guard wraps only the
expensive half — the visibility gates and the byte-cache lookup run outside it,
so a private wall is refused without spending a slot and a hot card never queues
behind a cold render.

**A missing object is a 404, not a 500.** A promoted wall can lose its public
copy: `deletePublicWallPhoto` is best-effort, a demote-then-re-promote mints a
new key, and `refreshPublicWallPhoto` has a catch path that leaves the row
pointing at an object that is gone. A non-2xx from the bucket, a fetch that
misses the 8s deadline, an object over the 12MB ceiling, and bytes sharp cannot
decode all become the ordinary `not-found` (`SprayPhotoUnavailableError`) — a
500 on a link somebody already posted is the worse answer, and a distinct "the
wall is real but its photo is missing" status would confirm the wall exists. A
genuine server fault — a database error, a bug — is not that error and still
answers 500.

**The drawing is sharp + SVG, not the WASM overlay.** The shared pipeline's image
resolver is synchronous and reads the local filesystem, which a photograph
fetched over HTTP can never satisfy, and its overlay draws a catalogue board's
fixed geometry. So this path resizes the photo `fit: 'inside'` the family's
544x602 art slot, places it against the text column like a board, and composites
one SVG mark per lit hold: the hold's traced silhouette as a polygon when
`spray_wall_holds.outline` has one, a circle at its mapped radius when it does
not — the same ring fallback the rest of the render path uses. Canonical
coordinates reach photo pixels through `invert()` of the version's stored
homography; a matrix that turns out singular logs at `warn` and renders the photo
with no overlay, because a card with no holds is a worse card and a 500 on a link
somebody already posted is a broken one.

Spray cards derive their frosted background from the same photo-mapped marks as
the foreground overlay, after every public-visibility gate. A singular matrix
still shows the photo, on neutral frost without coloured blobs.

**On the family grid.** The photo is rounded and hairline-bordered like a place
card's (`renderOgFamilyPhotoLayers`) and composed through `composeOgFamilyCard`,
which honours `format`. The text column draws the URL's `n`, `g`, `s` and `angle`
the way a catalogue climb card does, with the wall's own name and `Spray wall` as
the board line. www does not send identity params for a wall's climb today, so its
card leads with the wall's name. The name comes from the row the gates already
passed and is built only after them, so a private wall's name never reaches a
byte. Because it is drawn, it is in the in-process key with the climb text: a
rename redraws the card. A Pango failure costs the words, not the card.

## The share-card family (`/og/playlist`, `/og/session`, `/og/profile`, `/og/setter`, `/og/place`)

`packages/shared/board-render/src/og-family.ts` is the layout the other share
cards render through, the climb card included. The surface supplies an art slot
and a text stack; the ground (`#181225`), the frosted bokeh, the scrim, the column
and the wordmark are fixed. Since the climb card moved onto it, `og-family.ts` is
in `OPAQUE_RENDER_INPUTS`: an edit to it moves `BOARD_RENDER_VERSION` and every
climb card URL with it. `og-family-blocks.ts` (avatar, pill, dots, bars) is not. The `full` slot's numbers live in `headers.ts`
(`OG_CARD_BOARD_BOX`, `OG_CARD_COLUMN_LEFT`, `placeOgBoard`) so the browser's render
worker can size a board without importing sharp.

Slots are `full` (board in x 16-560, text column at x 590), `narrow` (a 290px slice
around the lit holds, text at x 322, used by the join and recap cards so the hero can be huge)
and `none` (no art, the stack centred across the crop). The hero (`V5–V9`,
`Join Huy Dang`) always ends inside x 285-915 so a square search crop keeps it. Fit
is measured through Pango, never estimated from character counts. A grade shrinks to
fit and is never cut or wrapped; a name wraps and, only below its size floor,
truncates. A left-aligned stack marks each line left-to-right, so a Hebrew or Arabic
name stays on the column's edge. The wordmark's right edge is fixed at x 1160 on every
slot, with the app icon 10px left of its first letter: a 30px rounded square (corner
radius 22%), centred on the letters' own height. The icon is
`packages/shared/board-render/assets/og-app-icon.png`, `packages/web/app/icon.png`
pre-sized to 30px and committed inside `@boardsesh/board-render`, so the backend image
gets it with the package source and no card resamples the 512px original. It is
decoded and rounded once per process. Both it and `og-family.ts` are in
`OPAQUE_RENDER_INPUTS`, so moving or redrawing it moves every climb card URL. A test
fails when the app icon changes and the committed copy does not; regenerate it with
sharp's default `resize(30, 30)`. If the icon cannot be read, every card still draws
its words and the wordmark alone, warns once, and retries the read on the next card.
Such a card is never the final drawing: it stays out of the byte caches, and
`/og/climb` answers it `no-store`. Family cards are JPEG only: a PNG option cost 397 KB per entry in the byte cache
shared with climb renders. The climb and spray cards are the exception, because
`/og/climb` has always honoured `format`. Grade colour comes from `FONT_GRADE_COLORS` with one shared lift
(`liftGradeColorForCard`) so V8 and up clear contrast on dark without changing hue.

**Data.** Each card runs GraphQL documents in process with graphql-js `execute` on
`schema`, using a fresh anonymous context per request (`createAnonymousOgContext`).
Calling resolvers directly would skip field-level masks such as the session roster
redaction and `boardLocationField`. The connection id has to be fresh on purpose:
with no user and no `clientIp`, it is the only key `applyRateLimit` has, so a
constant id would be one global rate-limit bucket for every card. A resolver
refusing with `NOT_FOUND`/`FORBIDDEN`/`UNAUTHENTICATED`/`BAD_USER_INPUT`, or with the
typed `PlaylistAccessDeniedError` or `InputValidationError`, becomes the same 404 as a
missing row. Those two are matched by class and never by message, so a database
failure stays a 500. A Pango failure also rejects: a card is mostly its words, and a
wordless card must never be served or cached under the real key.

**Gate, then cache.** A family card's bytes are not determined by its URL: a
playlist can go private and a session can end under an unchanged query string. So
responses are `private, no-store`, the gate query runs on every request before any
byte-cache read, and the byte key is the surface plus a digest of the data actually
drawn (the playlist's `gradeSummary` included, because its daily refresh does not
touch `playlists.updated_at`). Missing, private, `only_me`, invite-only and ended all
answer the identical `no-store` 404, so an id cannot be probed. Rate limits match
`/og/climb`: 120/min per IP, 600/min per peer. Behind the gate, a playlist's climbs
are held 10 minutes and a session's newest tick 60 seconds (`PostGateCache`), and
concurrent loads of one card share one gate and one read; only the gate is guaranteed
fresh, and it runs on every non-concurrent request.

**What a stranger can see.** The count on a playlist card is `playlistClimbs.totalCount`,
not `Playlist.climbCount`, which also counts drafts and hidden spray climbs. Other
callers of `climbCount` are unchanged.

**Playlist art.** One climb, in its real LED colours: the first in the list's own
order on the dominant `layoutId` of its first page, drawn on `getDefaultRenderBoard`'s
config for that layout. A multi-frame climb is flattened (`toFlatFrames`) so a hold it
clears still shows. The card never merges several climbs onto one board.

**Join.** Reads `boardPath` from `session`, in either form: `/b/<slug>` (resolved
through `boardBySlug`, which is why no board name or location is ever selected) or
the geometry path. The latest tick a stranger may see on that board is lit, from one
bounded row (`readLatestSessionTickFrames`) with session access, tick privacy (which
covers draft climbs) and the spray-wall rule applied where the row is chosen. An empty `frames`
draws the unlit board, no board means no art column, and `Join the crew` covers a roster with
nobody nameable. An ended session has no live roster, so `session()` is null: the
invite serves the recap instead of saying Join, and answers 404 only when there is
nothing a stranger may see to recap.

**Profile (`/og/profile?user_id=`).** `publicProfile.isPrivate` is checked first and a
private account stops there, before stats, frames, avatar or render. The hero is the
hardest send's logged grade, consensus only when nothing was logged, from
`userAscentsFeed(sortBy: hardest, statusMode: send, excludeHiddenClimbs: true)`, whose
tick privacy and spray rules keep a private tick, draft, unlisted or private-wall climb
off the card, and whose new filter passes over a community-hidden climb for the next
hardest. `Hardest of N` and the bars keep counting hidden climbs, as `userProfileStats`
does on the public profile.
`userProfileStats` replaces the old `userTicks` read, whose `difficulty` was null on
most ticks and left the chart empty. Stats are held 10 minutes; the hardest send 60
seconds, because it names one tick and a revoked tick should leave the card quickly.
An unnamed climber reads `Climber` with no monogram; no sends reads `No sends logged
yet` over an unlit Kilter. Grade bars draw only when clear of the text.

**Setter (`/og/setter?username=`).** One climb, the most sent, in its real LED colours,
drawn with `resolveRenderBoard` on a board it fits. The hero is `SetterProfile.totalAscents`:
each listable climb's best angle summed, not the sum across angles. Stats are per angle
and one climber sits on the row for every angle they have sent, so summing would
count them twice; KilterStudio is 1,136,595 this way and 2,035,138 summed, against
the owner's 1.1M, and it matches the per-climb count on the setter's own list. Under
10 sends the climb count becomes the hero. A setter whose climbs are all hidden keeps
the card, because the page still exists, with no art and no count to headline. The gate
is one bounded row with `setterProfile`'s own predicate (`setterHasVisibleClimbs`), since
`setterProfile` counts the whole catalogue, about a second on a 23,000-climb setter; its
result (count, boards, linked account) is held 60 seconds. The total and top climb are held
10 minutes, but the top climb is re-checked on every request (`isSetterClimbListable`), so
one hidden or withdrawn leaves the card on the next fetch.

**Recap (`/og/session?sessionId=`).** Access (`canAccessResource`) is checked on every
request, then one bounded read of at most 1,000 ticks (`readSessionRecap`) with the
anonymous rules in the `WHERE`: `sessionTickVisibleCondition`, which also covers draft,
unlisted and private-wall climbs. `sessionDetail` answers the same question but builds every tick's votes,
clips and attempt totals in front of every cache. Past 1,000 ticks the card says
`1,000+ sends logged` and the hardest grade is the hardest of those it read. The rollup is
held 60 seconds. Hero is the hardest grade, or `Still projecting` over the hardest
attempted grade with rings; one dot per send (filled is a flash, hollow a send), up to
one line, then `+N`. A hidden climb counts, as on the session page, but is never the one
featured. A crew session reads `Name + 2 others`; `sessionVisibleUserIds`
decides who may be named, so a masked climber is counted but never named and never
credited. `daily:` ids are not accepted (their rules live in `sessionDetail`), so
they keep the web route.

**Avatars.** `avatarUrl` is whatever the row holds, and Railway has a private network, so
a card fetches one only through `fetchAllowedImage` (`lib/safe-image-fetch.ts`, new `avatar`
host kind: our media CDN and Google's photo host). The same DNS private-address check
runs, redirects are refused because the allowlist only judged the first hop, the timeout
is 1.5 s, the body is capped at 3 MB and streamed, a declared non-image or zero-byte
response is rejected, and only bytes that start as JPEG, PNG or WebP reach sharp, under
a 13 MP input limit and a 2 s decode timeout. Any failure draws the monogram and the card still
answers 200. `/static/avatars/` paths are mapped straight to the media CDN, since a
request to our own route would only redirect there; with no media base configured
(local dev) the monogram draws. Results, failures included, are held 10 minutes per URL
so a slow host costs one timeout rather than one per request.

Cold reads behind the gates (`runCardRead`) run one at a time per process with eight
waiting at most, then answer 503 with `Retry-After`, the same as a saturated render
queue. The backend's pool is 5 connections and one cold `userProfileStats` is nine
transactions, so a second one alongside would only queue on the pool. Art renders through
the shared `runOnRenderSemaphore` cap. Board planes live in their
own small LRU (`ogFamilyPlaneCache`), because the climb card's `:og` base key omits
placement and sharing it could serve a misplaced plane and evict climb bases.

**Places (`/og/place?kind=gym|board&slug=`).** `gymBySlug` or `boardBySlug` is the
gate, run as an anonymous caller on every request; a gym or board a stranger cannot
open answers the one 404 before any photo, climb or byte-cache read. That means
private, followers-only, invite-only and admin-hidden boards get no card. An Unlisted
home board does: its slug is its link, and the link holder already reads that name
and config. An Unlisted spray wall does not, because a wall's slug is derived from
its name and is not its link (see `docs/spray-walls.md`). Nothing on the URL is a
capability, so no invite token can appear in one.

A gym prints its own name and the boards a stranger can see on its page, read with
`gymBoards`' own visibility rule and held for 60 s. `Gym.boardTypes` is not used
here: it counts every linked board, Only-me ones included. Its public photo takes the
art slot, fetched under the `place-photo` host kind with the avatar path's byte sniff,
pixel cap and timeouts, in a photo-only cap of its own so a CDN brownout cannot stall
other family cards. A photo that fails for any reason falls back to board art and
never fails the card; a timeout or 5xx is not remembered. With no photo it lights the
most-climbed listable climb on the type's `FALLBACK_BOARD_PREVIEW_CONFIGS` entry. No
boards and no photo is a centred name with no art. A board card draws its own config
and whatever `boardBySlug` returned, so a `hideLocation` board has no location on it,
and the config tail is stripped from an app-generated default name. A spray wall goes
through `spray-og-card.ts`'s gates (public, not hidden, published, public photo) and
its compositing. A photo that is gone or undecodable answers the 404, since a wall
has no board art to fall back to; a timeout or server error answers a 503 with
`Retry-After` and is not held.

The climb a card lights comes straight from the `searchClimbs` query, so drafts,
unlisted and community-hidden climbs are out, and is held for 60 s. It deliberately
skips the GraphQL resolver, whose anonymous catalogue pages stay in Redis for a day
with no invalidation. No catalogue climb count is ever printed about a place.

**Site default.** `packages/web/app/opengraph-image.tsx` (and `twitter-image.tsx`,
which re-exports it) draws the logo card with `next/og`: the app icon, the
`boardsesh` wordmark and "ONE APP FOR YOUR BOARDS" on the dark ground. It is not a
family card and never goes through the backend.

### Where www points, and what it says

Every page that has a family card puts it in `og:image` and `twitter:image` as an
absolute URL on the backend origin, built by `buildOgFamilyImageUrl`
(`packages/web/app/lib/seo/og-family.ts`) from the same `getPublicBackendHttpUrl`
the climb card uses. With no backend origin configured the page keeps the site
default card.

| Page | Card | Advertised only when |
|---|---|---|
| `/playlists/{uuid}` | `/og/playlist?uuid=` | the playlist is public |
| `/profile/{user_id}` | `/og/profile?user_id=` | the profile is not private |
| `/setter/{username}` | `/og/setter?username=` | the setter has a visible climb |
| `/session/{id}` | `/og/session?sessionId=` | a stranger can see at least one tick |
| `/join/{id}` | `/og/session?sessionId=&variant=join` | the session is live, or has a tick to recap |
| `/gym/{slug}` | `/og/place?kind=gym&slug=` (canonical slug) | the gym is public |
| `/b/{slug}/{angle}/list` | `/og/place?kind=board&slug=` | a stranger holding only the slug can open the board |
| same, on a spray wall | `/og/place?kind=board&slug=` | the wall is public and has a public photo copy |

Each rule is the backend card's own gate, so a page never advertises an image that
answers 404. A page that fails it keeps the site default card or none. The board
check asks `boardBySlug` again without the viewer's token when one is present
(`resolveBoardBySlugAsStranger`): a follower can open a board a stranger cannot. A
URL carries a public id or slug and its `v` token only, so `?invite=` and `?wall=`
never reach an image URL, and an unlisted wall keeps the default card. A climb
on a spray wall keeps its own climb card.

The `v` token is `BOARD_RENDER_VERSION`, a dash, then a token for the data the card
draws: a hash of the numbers and names on it where there is no single timestamp
(`buildOgContentVersion`), including the playlist's grade band and the setter's send
total and top climb. `buildOgFamilyImageUrl` adds the render half, so a change to the
drawing moves every family card URL the way it moves every climb card URL. The
backend ignores it; it is there so a chat app that caches previews by URL asks again
once the card has changed.

`og:title` and `og:description` are the share copy from the design doc, translated
in all five locales, and set separately from `<title>` and the meta description so
search titles do not move (`ogTitle` / `ogDescription` on `createPageMetadata`). They
never claim live state. An unnamed climber is `profile.page.displayNameFallback`. Session copy names grades and
counts, never a climb: the anonymous `sessionDetail` ticks carry no community-hidden
flag, and the backend card never features a hidden climb.

**`daily:` session ids.** A daily feed group is not a session and `/og/session`
refuses it, so its session and join pages keep advertising the web route's card,
`/api/og/session`, which still draws those groups, on the app's dark ground.

**Legacy URLs.** `/api/og/{playlist,profile,setter}` are 307 redirects to the
backend card, like `/api/og/climb`, so links shared before the move still unfurl.
They carry the id and `v` across and drop anything else, and cache for an hour at
the edge (`redirectToOgFamilyCard`). `/api/og/session` redirects every id except a
`daily:` one, which it still draws.

**The app.** The playlist and setter Share buttons and the session invite sheet
call `prewarmShareCaches` with the token-free card URL. The backend keys family
bytes on the drawn data, so that render is the one the advertised URL will hit, and
the advertised URL is not fetched a second time. `extractOgImageUrl` follows only
`/og/{climb,playlist,session,profile,setter,place}` on `BACKEND_URL`.

`/og/climb` also grew a guard for later changes: a request whose `v` differs from the
compiled `BOARD_RENDER_VERSION` answers the daily tier rather than `immutable`, so a
render change cannot pin old bytes for a year. A URL with no `v` stays immutable.
When the climb card moved onto the family grid the version moved with it, so every
URL web and mobile build changed.

What a version bump does and does not refresh:

- **Refreshes:** every URL built after the deploy, because it carries the new `v`.
  Pages re-render their `og:image` and the apps build share URLs from the constant,
  so new shares and re-scraped pages get the new card.
- **Does not refresh:** a URL already cached at Cloudflare under the old `v`. That
  response went out `immutable` for a year, and the edge keeps serving the old card
  for the rest of that year; nothing on our side can reach it without a purge token
  we do not hold. The daily-tier guard only applies when an old-`v` URL misses the
  edge and reaches the origin: it then gets the new drawing with a day of caching,
  not a year.
- **Does not refresh:** a preview a chat app stored itself. Discord, Slack and
  iMessage keep their own copy of an unfurl keyed by the page URL, not the image.

**Known limit:** `/render/board?variant=og` has no such guard. It answers whatever
`v` it is sent with `immutable`, so an old `v` that reaches the origin would pin the
new wordless card under the old URL for a year. No production page builds that URL
today (www's fallback to it only runs when no backend origin is configured), so it
is left as is.

`/render/board` without `variant=og` does not touch any of this: before and after the
move, plain, thumbnail, background, dimmed, dark and classic renders came out
byte-identical. `variant=og` is the card without words and moved with it.
