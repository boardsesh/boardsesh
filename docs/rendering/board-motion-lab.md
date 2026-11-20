# Board motion lab

A dev screen for comparing ways to change climbs on the player's GPU board. It draws the real player board, lets sliders retune a transition live, and plays the same scripted swipes for every variant, so two phones record identical input.

## Who can open it

Dev builds, testers and admins: the same people who see the dev tools on Settings > Developer. Everyone else who reaches the route is sent back to Settings. The lab ships in normal builds; its screen is only loaded when the route opens.

## Open it

- Settings > Developer > Board motion lab.
- Deep link: `com.boardsesh.app://settings/board-motion-lab?variant=<id>&board=<id>&set=<id>&speed=0.25&autoplay=all&reduceMotion=on`.
  - `variant`: a variant id; one this build can't run opens on I, or on the first variant it can run when I is out too. `board`: a board id from `fixtures.ts`. `set`: `real`, `none`, `half`, `mostly` or `role-change`.
  - `speed`: `1`, `0.5` or `0.25`. `reduceMotion`: `system`, `on` or `off`.
  - `preset`: `subtle` (the default) or `bold`, for every variant that has a Bold preset.
  - `autoplay`: `all` or one variant id.

## Screen

Caption bar (letter, variant name, speed, board), the board, a status line (`GPU · API 7 · prepare 42 ms · upload 3 ms`, `PNG · <reason>` or `Loading…`), then controls: Play script, Play all variants, variant, the Subtle / Bold preset (variants that have one), speed, Reduce Motion, one slider per parameter (committed on release), Copy params, Reset params, script, board, climb set. Variants that need a newer native API than the build has are greyed out with the reason. The lab opens on I (Ghost peek + standby) when the build can run it. There is no light/dark toggle; the lab follows the system theme.

For the swap looks the status line also says what the native view reports about the look: `look on (24 holds)` once a frame has drawn it, `look ready` before the first swipe, `look off (Reduce Motion)`, `look off (Differentiate Without Color)`, `look off (no look prop)` or `look off (look rejected)`, `look off (unsupported build: swapLookVersion 1)` when the binary is older than the JS, and `· reach off (Low Power)` or `(hot phone)` when glow reach is pinned at 1. On an older Android binary whose startup probe turned the look off (the legacy module constant `swapLookProbe`), the status line says why on every variant, since the looks are greyed out: `look off (probe timeout after 1000 ms; next launch retries)`, `look off (look shader rejected by this GPU (compile))`, or, on a later launch, `look off (look shader rejected by this GPU (compile); kept until the app or GPU driver updates)`. The native view also logs `swap look applied: N holds` once per view (subsystem `com.boardsesh.climb-overlay-gpu`, category `swap-look`).

### Presets and speed

Each swap look has two presets. **Subtle** is the variant's defaults: the values the design reviews picked, which read as "more polished" at 1× without an obvious effect. **Bold** pushes the same look far enough to see what it does at 1× (narrow per-hold windows so the sweep travels, linear side weights, 1.25-1.35× swells). Bold values are for exploring, not flash-safe: perf-a11y's R7 limits (swell at most 0.06 on the plateau 0.7 falloff) apply to whatever ships. Picking a preset loads it into the sliders and drops this variant's slider changes; Reset params goes back to Subtle.

To judge a look, play it at 0.25×: at 1× its fronts last 40-120 ms, which the eye takes in as "smoother" without seeing why. The slow speed shows the order holds light in, the ghosts and the standby rings. For E and I, also try a slow drag at 1× and stop at 40-60 pt: the ghosts are the part a climber uses.

## Add a variant

One file in `src/components/board-motion-lab/variants/` exporting a `BoardMotionVariant` (see `types.ts`), plus one line in `variants/index.ts`. Its `params` become sliders; `createTransition(params)` returns the transition the carousel uses.

## The swap look (D to J)

A to C change only the three per-kind weights. D (Sideways cascade), E (Ghost peek), F (Climb-up), G (LED strike), H (Focus in), I (Ghost peek + standby, the round-2 pick: E's ghosts with G's standby ring on the climb being left) and J (Sideways strike, perf-a11y's re-tuned G) also send a native swap look, which gives each hold its own timing and glow. The lab lists them I, J, then D to H. Both platforms draw it: the module constant `swapLookVersion` is 2 on iOS and on Android, and the lab greys the looks out on an older binary, where it is below 2. On current Android binaries the constant describes protocol support only. The render worker compiles the optional program when an active, visible view first requests the look, at most once per EGL context. Rejection keeps the shipped swap and the view reports the look unavailable. Module startup and constant reads do no EGL or shader work. Older binaries keep their startup-probe behavior (`docs/rendering/gpu-climb-overlay-experiment.md`).

- The wall swap's state machine still decides one weight per side, so cancels, re-flicks, reversals and pull-backs behave as in the player. The native side (`ClimbOverlaySwapLook.swift`) turns a side's weight into each hold's weight with a front: holds change in order of a key (distance from the edge that climb enters from, or bottom to top for F's arriving climb), each over its own window. At weight 1, at the drag floor and at 0 every hold of a side looks the same, so a relabelled pair or a re-flick never jumps.
- An arriving climb can have its own floor (`arrivalFloor`): equal to the drag floor it first comes up to the floor everywhere, then sweeps; at 0 it lights in one front from dark to whole (the Bold presets).
- Per hold it also splits the mark from the glow (E and I's ghosts, G and I's standby rings) and changes the glow reach between 0.6× and 1.35× (arriving holds swell or focus from wide, leaving holds pull their glow in). Reach stays at 1 in Low Power Mode or Battery Saver and on a hot phone (iOS thermal state serious, Android thermal status severe or worse). Reduce Motion (Android: Remove animations, or the app's own setting) turns the look off natively, whatever the app sends, and on iOS so does Differentiate Without Color (ghosts show role colour without role shape). In the look, a hold past its own reach takes a pixel only where it is nearer than the hold that would light it, as at rest, and its claim fades with its glow; a neighbour's faint-field bias never hands it one, so a ghost's halo is never cut along a lit neighbour's box, and a look frame at W = (1, 0) or (0, 1) draws the still frame pixel for pixel (`scripts/board-motion-preview` checks both on I's sheets, on Metal and on an emulator's GLES). A ghost hides a neighbour's halo inside its own silhouette only as its glow comes in, over its first 0.1. Android's GLES look program follows the same rules.
- Swift computes this once per frame for at most 2 × 128 holds and binds it as fragment buffer 5; the shader reads one `ushort4` per candidate hold. Android's `OverlaySwapLook.kt` ports it and writes the same words into one reused array, and a second GLES program, built beside the base one, reads the same bytes from a 2 KB uniform block at binding 1 (two holds per `uvec4`). A uniform block, not a fifth storage buffer: GLES 3.1 only promises four storage blocks per fragment shader, and the renderer already uses four. Every Android frame without the look draws with the base program, main's source byte for byte (`OverlayShaderTest` pins its hash). With no look the Metal shader takes API 7's path byte for byte, and so does the GLES look program (checked by `scripts/board-motion-preview`, on Metal and on an emulator's GLES). One known gap between the ports: Kotlin's `Float.pow` and Swift's `powf` differ by one float step for about 0.7% of inputs, which moves H's focus reach word by 1/32768 in about 5 of 2 million sampled inputs.
- The look's numbers are the `swapLook` view prop: the player's from `PLAYER_SWAP_LOOK`, the lab's set when a slider is released. Each frame adds two numbers to the swap frame (seven with the sequence): an arrival code for the climb being left and for the arriving one (leaving; arriving from the right or the left edge; plus calm). A climb takes its code when it shows up as the incoming climb, keeps it, entry edge included, until its weight is 0 or 1: a climb skipped mid-front by a quick re-flick keeps its front's side. The fourth number is the floor below which shared holds never go (when the look is not drawn, native uses the shipped shared weight instead); a commit within the flick-run window eases it to 1.
- Flick runs (E and I): a drag that starts within `runWindowMs` of the last commit shows no ghosts and no drag dim, the run's arrival has no swell, and the swap takes `runSwapMs`. A fast run never shows the next climb's ghosts or pulses halos.
- To see a variant without a phone, `scripts/board-motion-preview/README.md` renders contact sheets and 60 fps videos (1× and 0.25×, each beside A) on the Mac's GPU with the real shader.
- Android's look program has been verified on an emulator (ANGLE on SwiftShader). Real Adreno and Mali checks are tracked in [#7796](https://github.com/boardsesh/boardsesh/issues/7796), along with a faint curved seam beside some lit holds of the same colour. A phone whose driver fails to compile or link it reports the look unavailable from the view and draws every frame with the base program; earlier probe-based binaries instead reported `swapLookVersion` 0.

## I is the player's look

Since 2026-11-18 the player draws I on Subtle on every binary with `swapLookVersion` 2, iOS and Android (Marco's pick after trying I against J on an iPhone 13 Pro). It ships to 100% behind the kill switch `player-swap-look-kill` (docs/operations/feature-flags.md), which is also the QA switch for comparing it with A: Settings > Developer > Feature Flags, and the open board changes at once. Older binaries, Differentiate Without Color (iOS) and the switch get A, the base swap. With Reduce Motion, the player and the lab’s wall swap variants use a linear 240 ms crossfade by default, with shared holds fully lit and no drag dim.

- **One source of truth.** The numbers are `PLAYER_SWAP_LOOK` in `play-drawer/player-swap-look.ts`. The lab's I takes its Subtle preset from that constant, so the lab's I is the player's look until a slider moves. The driver (`play-drawer/swap-look-driver.ts`) and its transition builder (`swapLookTransition`) are the player's too; every lab look variant runs through them.
- **To change the look:** retune I in the lab, Copy params, put the values into `PLAYER_SWAP_LOOK`, then render the previews (`scripts/board-motion-preview/README.md`) and check that `neverDarkerThanShipped` in `summary.json` is still true for both of I's Subtle tracks, and that parity is still 42 of 42. `look-variants.test.ts` fails if I's defaults and the player's look ever differ.
- **What changed from round 2's I:** `ghost` 0.35 → 0.4 and `outgoingEndMs` 120 → 150. In a flick re-flicked 90 ms after it commits, the climb it skips keeps its arriving rules as it fades, and with `ghost` below the arrival floor its glow fell to 0.875× its weight. The board's darkest moment after that commit measured 10.4 mean glow chroma against A's 10.7 (1×; 10.3 against 10.6 at 0.25×). Now an arriving climb's glow equals its weight and a ghost only holds its marks back, and the old rings stay 30 ms longer. `tighten` was not the cause: setting it to 0 left that trough at 10.4. Each of the two changes alone left it at 10.6 against 10.7 at 1×; both give 10.9 against 10.7 (1×) and 10.9 against 10.6 (0.25×). The slow drag and the quick flick got brighter, not darker (11.8 and 12.4 against A's 10.7 and 10.8). Rest is unchanged.

## Scripts and Play all

`scripts.ts` holds the scripted swipes (`FINGER_SCRIPTS`) and the one `SHOWCASE_SCRIPT` that Play all runs. Play all is a hands-free demo: for each available variant it selects the variant (the caption switches), puts the board back on the set's first climb, waits up to 2 s for the board to report GPU or PNG, holds 800 ms, plays the showcase script, then rests 600 ms before the next. A script that never finishes is stopped at its length (at the chosen speed) plus 2 s. Every variant swipes the same climbs. Stop cancels it, or ends a single script.

A script drives the real swipe code through a virtual finger. The board takes no touches while one plays, and a zoomed board is zoomed back out first, since a zoomed board refuses the swipe. With no board to swipe (no bundled art, no climbs) a script ends at once. Each run plays once: changing variant, a slider, speed or Reduce Motion mid-script ends the run where it is (the board is rebuilt for the new transition) and never replays it.

### What speed slows down

At 0.5× and 0.25× only two things slow down: the transition's own clocks (the swap and the settle) and the scripted finger. The swipe's settle spring still runs at real speed. That is the fling after a release, which moves the header to the next climb and tells the swap the climb has arrived (about 90 to 200 ms). So a slowed run is not a slowed copy of the 1× run: the climb arrives sooner relative to the finger and the swap. "Flick again mid-swap" shows it most: at 1× its second touch takes over a fling still running (the #7750 case), at 0.25× it lands 320 ms after the first release, when that fling has long landed, which is a different path. Judge that script at 1×. Release velocities are not scaled, so every speed commits the same swipes.

## Build to a phone

- Debug: `vp run mobile:ios -- --device <udid>`
- Release: `vp run mobile:ios -- --device <udid> --configuration Release`. No special env is needed.

The iOS Simulator reports native API 1, so it draws PNG and can't show GPU motion. Use a real phone or an Android emulator.

On PNG (the status line says `PNG`), every swap variant plays the PNG board's still wall (`play-drawer/png-swap-layers.ts`): its driver's two side weights fade whole boards over a bare wall, so timings, speed and Reduce Motion carry over but the per-hold look does not. The wipe still slides the whole board. The `png-wall-fade-kill` switch brings the slide back for every variant.
