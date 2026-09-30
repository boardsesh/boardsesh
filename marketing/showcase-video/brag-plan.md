# Homepage showcase video: plan

A 21.9 s, 1920x1080, 30 fps motion-graphics cut for the homepage hero, plus a
9:16 version for stories. Built the brag-slim way: every frame is a pure
function of its number, so any frame renders the same on any run.

## Pieces

| Piece                                             | What it does                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/lib/showcase-video/contract.ts`          | Paths, takes, anchor names and the anchors file format shared by recorder, app and renderer                                                                                          |
| `scripts/lib/showcase-video/timeline.ts`          | Scene boundaries (frames), backgrounds, which takes and callouts each scene uses                                                                                                     |
| `scripts/lib/showcase-video/render.ts`            | Pure helpers: poses, `screenToCanvas`, reading budget, leader gutters, lit-hold detection, every ffmpeg argument vector, placeholder takes                                           |
| `packages/web/scripts/render-showcase-video.ts`   | Drives Chromium over `index.html`, pipes 2x PNGs into a 1x mezzanine, cuts every deliverable from it                                                                                 |
| `marketing/showcase-video/index.html`             | The stage. `window.showcaseInit(data)` builds the DOM once; `window.renderAt(frame)` only writes CSS custom properties, SVG attributes and `img.src`                                  |
| `timeline.mjs` / `anim.mjs`                       | Per-frame choreography / closed-form tween, spring, cubic-bezier, OKLab mix and the phone projection                                                                                 |
| `copy.en-US.json`                                 | Every word on screen. `*word*` is the Instrument Serif accent, `\n` a forced break                                                                                                  |
| `holds.json`                                      | Fallback motif holds, used only when detection finds fewer than three lit holds on the light take                                                                                    |
| `fonts/`                                          | Inter Tight, Instrument Serif Italic, Geist Mono (latin woff2 from Google Fonts, OFL; licences beside them)                                                                           |
| `tokens.css`                                      | Generated on every render from `@boardsesh/velvet-tokens`, `@boardsesh/board-constants` and the web theme. Gitignored                                                               |

## Storyboard (frames at 30 fps)

| #   | Scene  | Frames  | Background | Copy                                  | On screen                                                                                                         |
| --- | ------ | ------- | ---------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | hook   | 0–72    | dark       | Your board. Lit from your _phone._    | Dot grid + the light take's lit holds as rings on a Catmull-Rom line; amber spark runs start→finish (12–48)       |
| 2   | light  | 72–192  | dark       | Swipe, and the wall _follows._        | Phone springs in; rings land on the footage's holds (match cut); callouts "On the wall", "Swipe for next"        |
| 3   | boards | 192–282 | lavender   | Every board. One _app._               | Kilter, Tension, MoonBoard phones rise with a stagger; labels above                                               |
| 4   | crew   | 282–410 | dark       | Your crew. One _queue._               | Callouts "Scan to join", "Who queued it", "Play next"                                                             |
| 5   | log    | 410–528 | lavender   | Remember every _send._                | Tilted phone on the logbook; three-row checklist ticks, amber progress underline                                  |
| 6   | outro  | 528–657 | dark       | Less phone. More _wall._              | Mark, `boardsesh` wordmark, dots line drawn by the spark, "Free, no ads. iOS & Android." pill; loop closer        |

Crew, log and outro moved from the first cut (282–402, 402–507, 507–657) to
meet the reading budget: 0.3 s per visible word between the first word landing
and the exit starting. `readingBudgetReport` prints the numbers on every
render and a test holds them.

## Rules the stage keeps

- No CSS transitions or animations, no `Date`, no `Math.random`.
- Footage cuts hard at scene boundaries; only the phone moves across a
  background change (OKLab tween, L−4..L+6). New text starts at L+6.
- One amber element per scene at most (the spark, or the log's underline).
- Frame 0 is the settled poster. The last 24 frames blur the outro out, grow
  the hook's rings back out of the outro dots and blur the hook headline in, so
  the web cut (frames 1..656) loops without a seam.

## Commands

```sh
vp run video:render -- --placeholder-footage --stills   # stand-in footage + contact sheets
vp run video:render -- --stills --measure               # anchor boxes over the footage
vp run video:render                                      # both formats, all deliverables
vp run video:render -- --format 16x9 --from-frame 400   # quick preview from a frame
```

Outputs: `.boardsesh/showcase-video/out/brag.mp4` (+ `brag.jpg`,
`share-copy.txt`, `stills/`), the web cut in `packages/web/public/videos/home/`
and posters in `packages/web/public/images/home/`. Each web file must stay
under 1.8 MB (`scripts/check-large-files.mjs` fails at 2 MB).
