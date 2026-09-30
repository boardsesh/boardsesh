# Homepage showcase video: plan

A 38.2 s (1145 frames), 1920x1080, 30 fps motion-graphics cut for the
homepage hero, plus a 9:16 version for stories. Built the brag-slim way:
every frame is a pure function of its number, so any frame renders the same
on any run.

## Pieces

| Piece                                           | What it does                                                                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lib/showcase-video/contract.ts`        | Paths, takes, app and static anchor names and the anchors file format shared by recorder, app and renderer                                                                                    |
| `scripts/lib/showcase-video/timeline.ts`        | Scene boundaries (frames), backgrounds, which takes and callouts each scene uses, which takes may be missing                                                                                 |
| `scripts/lib/showcase-video/render.ts`          | Pure helpers: poses, `screenToCanvas`, reading budget, leader planning, the boards pile-up plan, workout ticks, lit-hold detection, placeholder takes and cards, every ffmpeg argument vector |
| `packages/web/scripts/render-showcase-video.ts` | Drives Chromium over `index.html`, pipes 2x PNGs into a 1x mezzanine, cuts every deliverable from it, then deletes the mezzanine and pass logs                                                |
| `marketing/showcase-video/index.html`           | The stage. `window.showcaseInit(data)` builds the DOM once; `window.renderAt(frame)` only writes CSS custom properties, SVG attributes and `img.src`                                           |
| `timeline.mjs` / `anim.mjs`                     | Per-frame choreography / closed-form tween, spring, cubic-bezier, OKLab mix and the phone projection                                                                                          |
| `copy.en-US.json`                               | Every word on screen. `*word*` is the Instrument Serif accent, `\n` a forced break. Board names come from `BOARD_TYPE_LABELS`                                                                 |
| `holds.json`                                    | Fallback motif holds, used only when detection finds fewer than three lit holds on the light take                                                                                             |
| `fonts/`                                        | Inter Tight, Instrument Serif Italic, Geist Mono (latin woff2 from Google Fonts, OFL; licences beside them)                                                                                    |
| `tokens.css`                                    | Generated on every render from `@boardsesh/velvet-tokens`, `@boardsesh/board-constants` and the web theme. Gitignored                                                                         |

## Storyboard (frames at 30 fps)

| #   | Scene       | Frames    | Background | Copy                                | On screen                                                                                                                                                 |
| --- | ----------- | --------- | ---------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | hook        | 0–72      | dark       | Your board. Lit from your _phone._  | Dot grid + the light take's lit holds as rings on a Catmull-Rom line; amber spark runs start→finish (12–48)                                               |
| 2   | light       | 72–192    | dark       | Swipe, and the wall _follows._      | Phone springs in; rings land on the footage's holds (match cut); callouts "On the wall", "Swipe for next"                                                |
| 3   | boards      | 192–330   | lavender   | Every board. One _app._             | Kilter, Tension, MoonBoard rise neatly; Woods, Decoy, Touchstone, Grasshopper crowd in from the sides; So iLL pops up into the middle and jostles its neighbours |
| 4   | wall        | 330–486   | dark       | See what's on the _wall._           | Callouts "Board history", "On the wall now", "Lit on this wall" (the history box grows down over the list)                                               |
| 5   | crew        | 486–614   | lavender   | Your crew. One _queue._             | Callouts "Scan to join", "Who queued it", "Play next" in the light-scene hues                                                                             |
| 6   | workouts    | 614–776   | dark       | Give your session a _plan._         | Tilted phone; a pyramid checklist (V2 warm-up → V6 top → V4) ticks every 12 frames, with a rest countdown after the top set                              |
| 7   | lock-screen | 776–902   | lavender   | Change climbs without _unlocking._  | Lock-screen phone; callouts "Next", "Relight wall", "Mirror climb" (risers from the button row)                                                         |
| 8   | log         | 902–1016  | dark       | Remember every _send._              | Callouts "Every board", "Activity"                                                                                                                        |
| 9   | outro       | 1016–1145 | dark       | Less phone. More _wall._            | Mark, `boardsesh` wordmark, dots line drawn by the spark, "Free, no ads. iOS & Android." pill; loop closer                                                |

Scene lengths meet the reading budget: 0.3 s per visible word between the
first word landing and the exit starting, counting every board label and
callout. `readingBudgetReport` prints the numbers on every render and a test
holds them.

## Rules the stage keeps

- No CSS transitions or animations, no `Date`, no `Math.random`.
- Footage cuts hard at scene boundaries; only the phones move across a
  background change (OKLab tween, L−4..L+6). New text starts at L+6.
- Backgrounds alternate from the boards scene on. The two dark→dark joins are
  deliberate: hook → light is the match cut, log → outro hands a phone to the
  centred end card.
- Callouts work on both backgrounds. Lavender scenes draw the roles a step
  darker (start `#047857`, hand `#0E7490`, finish `#A21CAF`, each ≥ 3:1 on
  `#F4F1FB`) on a white pill with a hairline border; dark scenes keep the LED
  hues with a glow.
- A callout whose sideways leader would cut through another callout's box
  leaves from the box top instead (the lock screen's button row).
- One amber element per scene at most (the spark, or the workouts rest ring).
- Nothing enters over the headline: a dark phone crossing dark ink hides it.
- Frame 0 is the settled poster. The last 24 frames blur the outro out, grow
  the hook's rings back out of the outro dots and blur the hook headline in, so
  the web cut (frames 1..1144) loops without a seam.
- A missing board take is skipped with a warning; the pile-up uses the boards
  that were recorded. Any other missing take stops the render.

## Commands

```sh
vp run video:render -- --placeholder-footage --stills   # stand-in footage + contact sheets
vp run video:render -- --stills --measure               # anchor boxes over the footage
vp run video:render -- --frame 264 --format 16x9        # one full-size frame
vp run video:render                                      # both formats, all deliverables
vp run video:render -- --format 16x9 --from-frame 400   # quick preview from a frame
```

Outputs: `.boardsesh/showcase-video/out/brag.mp4` (+ `brag.jpg`,
`share-copy.txt`, `stills/`), the web cut in `packages/web/public/videos/home/`
and posters in `packages/web/public/images/home/`. The web cut is encoded at
580 kbit/s (the quality of the first 22 s cut); each file must stay under 4 MB,
and the four files are allowlisted in `scripts/check-large-files.mjs`.
