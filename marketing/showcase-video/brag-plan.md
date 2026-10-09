# Homepage showcase video: plan

A 54.8 s (1644 frames; 48.8 s without the island scene), 1920x1080, 30 fps motion-graphics cut for the
homepage hero, plus a 9:16 version for stories. Built the brag-slim way:
every frame is a pure function of its number, so any frame renders the same
on any run.

## Pieces

| Piece                                           | What it does                                                                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lib/showcase-video/contract.ts`        | Paths, takes, app and static anchor names and the anchors file format shared by recorder, app and renderer                                                                                    |
| `scripts/lib/showcase-video/timeline.ts`        | Scene boundaries (frames), backgrounds, which takes and callouts each scene uses, which takes may be missing                                                                                 |
| `scripts/lib/showcase-video/render.ts`          | Pure helpers: poses, `screenToCanvas`, reading budget, leader planning, the boards pile-up plan, workout ticks, placeholder takes and cards, every ffmpeg argument vector |
| `packages/web/scripts/render-showcase-video.ts` | Drives Chromium over `index.html`, pipes 2x PNGs into a 1x mezzanine, cuts every deliverable from it, then deletes the mezzanine and pass logs                                                |
| `marketing/showcase-video/index.html`           | The stage. `window.showcaseInit(data)` builds the DOM once; `window.renderAt(frame)` only writes CSS custom properties, SVG attributes and `img.src`                                           |
| `timeline.mjs` / `anim.mjs`                     | Per-frame choreography / closed-form tween, spring, cubic-bezier, OKLab mix and the phone projection                                                                                          |
| `copy.en-US.json`                               | Every word on screen. `*word*` is the Instrument Serif accent, `\n` a forced break. Board names come from `BOARD_TYPE_LABELS`                                                                 |
| `fonts/`                                        | Inter Tight, Instrument Serif Italic, Geist Mono (latin woff2 from Google Fonts, OFL; licences beside them)                                                                                    |
| `tokens.css`                                    | Generated on every render from `@boardsesh/velvet-tokens`, `@boardsesh/board-constants` and the web theme. Gitignored                                                                         |

## Storyboard (frames at 30 fps)

| #   | Scene       | Frames    | Background | Copy                                | On screen (cut on the take's marks)                                                                                          |
| --- | ----------- | --------- | ---------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | boards      | 0–156     | dark       | Every board. One _app._             | Opens settled on Kilter, the spray wall and Tension; from frame 40 MoonBoard, Woods, Decoy, Touchstone, Grasshopper crowd in and So iLL pops up beside the spray wall: nine phones |
| 2   | spray       | 156–336   | lavender   | Your spray wall, _too._             | The spray wall's phone steps out of the pile: a climb on the wall's own photo, then two swipes (`next-1`, `next-2`); "Holds on your photo" |
| 3   | wall        | 336–606   | dark       | See what's on the _wall._           | The board-button tap up to `sheet-open` ("Board history", "On the wall now"), cut to `history-shown` ("Lit on this wall")    |
| 4   | crew        | 606–888   | lavender   | Your crew. One _queue._             | The invite QR (before `invite-closed`), the row landing (`row-landed`, "Who queued it"), the long-press menu ("Play next")   |
| 5   | workouts    | 888–1056  | dark       | Give your session a _plan._         | `pyramid-picked`, cut to the rest pill counting after `rest-armed`; the checklist ticks V2 → V6 → V4 and reads the pill     |
| 6   | lock-screen | 1056–1236 | lavender   | Control the wall from the _island._ | The real Dynamic Island: `island-expanded` on "Masquerade", cut to `next-tapped` and ~2.5 s of "Putty"; zoomed on the island |
| 7   | log         | 1236–1452 | dark       | Remember every _send._              | The "Every board" filter after `scrolled`, cut to Kilter picked (`filter-kilter`) and the calendar redrawn ("Activity")     |
| 8   | outro       | 1452–1644 | dark       | Less phone. More _wall._            | Mark, `boardsesh` wordmark, dots line drawn by the spark, "Free, no ads. iOS & Android." pill, "Paid for by the climbers who use it." under it; loop closer|

`SHOWCASE_TAKE_EDITS` in `scripts/lib/showcase-video/render.ts` holds the
footage each scene plays, each callout's window and the anchor corrections, all
as offsets from the take's marks (`work/marks/<take>.json`, written by the
recorder), so a re-record needs no edits. Anchors inside a native sheet are
measured from the sheet's top (wall sheet 462 pt, 145 pt once dragged up from
`history-shown`; invite sheet 405; queue sheet 322), and the log take's anchors
keep their pre-scroll `y` (−338 pt from `scrolled`, −415 once the Kilter view
drops a footnote). A render stops when a mark it needs is missing.

The island scene shows only the recorder's footage of the real Live Activity.
`--placeholder-footage` draws a stand-in island for layout work (tagged
PLACEHOLDER ISLAND and marked on disk, so a render without that flag never
shows it) and never overwrites a recorded take. Without a recorded
`lock-screen` take the scene is dropped, the cut closes up to 1464 frames
(48.8 s) and backgrounds re-alternate (log turns lavender).

Scene lengths meet the reading budget. A scene needs 0.3 s per visible word
(headline, board labels, workout rows and every callout label together)
between the first word landing and the exit starting. Each callout needs to sit
fully settled (box, leader and pill all in) for max(1.6 s, 0.45 s a word)
before it or anything else in the scene exits, and callouts enter at least
0.5 s apart. The callout scenes (spray, wall, crew, island, log) are as long as
that needs; the boards scene is as long as its nine labels need; the others
keep the rhythm. Where the app moves on before a callout
has been read, the edit holds a still frame (`hold` in `SHOWCASE_TAKE_EDITS`:
0.3 s on the invite QR, 1.2 s on the log's progress page). `readingBudgetReport`
prints a table (headline words, callout words, settled and required seconds,
per scene and per callout) on every render, and a test holds it.

The outro's "Paid for by the climbers who use it." is the homepage's
`proofNoCount` wording and never claims tax relief or perks. Store previews and
install ads must not mention donations: the `reel`, `app-store` and
`play-promo` targets are defined without it, and `--no-donation-line` drops it
from any target (leaving out `homepage`, which keeps it).

## Rules the stage keeps

- No CSS transitions or animations, no `Date`, no `Math.random`.
- A background change is the new colour revealed as a circle growing from the
  phone (L−4..L+6), never an OKLab crossfade: a crossfade passes through a
  flat mid-grey that reads as a dropped frame when the phone stands still. The
  renderer fails on any frame whose luma is a flat fill (`isFlatFrame`).
- The homepage hero is the only web output: `showcase-9x16-lite.{webm,mp4}`
  (720x1280, bitrates sized to ≤ 1.75 MB VP9 and ≤ 1.9 MB H.264) and its poster
  `showcase-hero-9x16.webp`. Both open on frame 0, the boards trio settled
  (`SHOWCASE_WEB_POSTER_FRAME`), like `brag.mp4` and `brag.jpg`.
  `--poster-frame <n>` picks another frame and plays the web encodes rotated,
  n..1643 then 0..n−1, which is as seamless as the loop.
- Footage cuts hard at scene boundaries; only the phones move across a
  background change (L−4..L+6). New text starts at L+6.
- Backgrounds alternate from the first scene on: dark, lavender, dark, … The
  one dark→dark join is deliberate: log → outro hands a phone to the centred
  end card.
- Callouts work on both backgrounds. Lavender scenes draw the roles a step
  darker (start `#047857`, hand `#0E7490`, finish `#A21CAF`, each ≥ 3:1 on
  `#F4F1FB`) on a white pill with a hairline border; dark scenes keep the LED
  hues with a glow.
- A callout whose sideways leader would cut through another callout's box
  leaves from the box top instead (the island's button row). In 9:16, when the
  zoomed phone leaves no room at the sides, pills stack below the boxes.
- Callouts are sized for a phone: 84 px pills with 36 px labels in 16:9
  (7.3 CSS px when the cut plays 390 px wide), 72 px pills with 32 px labels in
  9:16 (11.6 CSS px), 4 px leaders. `calloutLabelCssPx` computes it.
- No phone screen is ever white or lavender: every take and placeholder is the
  dark app.
- Every board phone shows a real lit board: a recording, a store screenshot, or
  (placeholder only) the board's most popular climb drawn by the public
  `/render/board`. A board with none of those sits out the pile-up; no board is
  ever a generated card.
- One amber element per scene at most (the spark, or the workouts rest ring).
- Nothing enters over the headline: a dark phone crossing dark ink hides it.
- Frame 0 is the settled poster: the headline, the trio and its three labels,
  nothing moving until the pile-up starts at frame 40. The last 24 frames blur
  the outro out, bring the trio back up from below (landing on the last frame
  exactly where frame 0 has it, its footage counting back from the cut's end)
  and blur the headline and labels in, so the loop has no seam.
- The board labels follow the boards scene's tone: light ink on the dark stage,
  and in 9:16 a dark chip, since a label there can sit over the row behind.
- The spray wall's phone is the one that stays: it stands in the middle of the
  trio and of the pile, then steps out into its own scene.
- A missing board take is skipped with a warning; the pile-up uses the boards
  that were recorded. A missing island take drops that scene. Any other
  missing take stops the render.

## Commands

```sh
vp run video:render -- --stills                         # contact sheets from the recorded takes
vp run video:render -- --stills --measure               # anchor boxes over the recorded footage
vp run video:render -- --placeholder-footage --stills   # stand-ins for takes not recorded yet
vp run video:render -- --frame 136 --format 16x9        # one full-size frame
vp run video:render                                      # both formats, all deliverables
vp run video:render -- --format 16x9 --from-frame 400   # quick preview from a frame
vp run video:render -- --target reel                     # one target (homepage, social, reel, app-store, play-promo)
vp run video:render -- --target all                      # every target
```

Outputs, per render target (`scripts/lib/showcase-video/targets.ts`,
docs/showcase-video.md "Targets"): `social` writes the full-quality masters
`.boardsesh/showcase-video/out/social/brag.mp4` and `brag-9x16.mp4` (+
`brag*.jpg`, `share-copy.txt`); `reel`, `app-store` and `play-promo` write to
`out/reel/`, `out/app-store/` and `out/play/`; `homepage` writes the hero's
`showcase-9x16-lite.{webm,mp4}` in
`packages/web/public/videos/home/` and `showcase-hero-9x16.webp` in
`packages/web/public/images/home/`. The webm must stay under 1.75 MB and the
mp4 under 1.9 MB (`SHOWCASE_WEB_LITE`), inside the 1.9 MB hard gate
(`SHOWCASE_WEB_MAX_BYTES`) and below `scripts/check-large-files.mjs`'s 2 MB, so
neither needs an allowlist entry. After a render, run
`vp run generate:static-assets` and commit the files with the catalog.
