# Board motion lab

A dev screen for comparing ways to change climbs on the player's GPU board. It draws the real player board, lets sliders retune a transition live, and plays the same scripted swipes for every variant, so two phones record identical input.

## Who can open it

Dev builds, testers and admins: the same people who see the dev tools on Settings > Developer. Everyone else who reaches the route is sent back to Settings. The lab ships in normal builds; its screen is only loaded when the route opens.

## Open it

- Settings > Developer > Board motion lab.
- Deep link: `com.boardsesh.app://settings/board-motion-lab?variant=<id>&board=<id>&set=<id>&speed=0.25&autoplay=all&reduceMotion=on`.
  - `variant`: a variant id; one this build can't run opens on the first it can. `board`: a board id from `fixtures.ts`. `set`: `real`, `none`, `half`, `mostly` or `role-change`.
  - `speed`: `1`, `0.5` or `0.25`. `reduceMotion`: `system`, `on` or `off`.
  - `autoplay`: `all` or one variant id.

## Screen

Caption bar (letter, variant name, speed, board), the board, a status line (`GPU · API 7 · prepare 42 ms · upload 3 ms`, `PNG · <reason>` or `Loading…`), then controls: Play script, Play all variants, variant, speed, Reduce Motion, one slider per parameter (committed on release), Copy params, Reset params, script, board, climb set. Variants that need a newer native API than the build has are greyed out with the reason. There is no light/dark toggle; the lab follows the system theme.

## Add a variant

One file in `src/components/board-motion-lab/variants/` exporting a `BoardMotionVariant` (see `types.ts`), plus one line in `variants/index.ts`. Its `params` become sliders; `createTransition(params)` returns the transition the carousel uses.

## The swap look (D to H)

A to C change only the three per-kind weights. D (Sideways cascade), E (Ghost peek), F (Climb-up), G (LED strike) and H (Focus in) also send a native swap look, which gives each hold its own timing and glow. iOS only: the module constant `swapLookVersion` is 1 on iOS and 0 on Android, and the lab greys D to H out where it is 0. The player sends no look and draws the shipped swap.

- The wall swap's state machine still decides one weight per side, so cancels, re-flicks, reversals and pull-backs behave as in the player. The native side (`ClimbOverlaySwapLook.swift`) turns a side's weight into each hold's weight with a front: holds change in order of a key (distance from the edge that climb enters from, or bottom to top for F's arriving climb), each over its own window. At weight 1, at the drag floor and at 0 every hold of a side looks the same, so a relabelled pair or a re-flick never jumps.
- Per hold it also splits the mark from the glow (E's ghosts, G's afterglow) and changes the glow reach between 0.6× and 1.35× (D, F and G swell an arriving hold, H focuses it from wide, G and H pull a leaving hold's glow in). Reach stays at 1 in Low Power Mode and on a hot phone. Reduce Motion turns the look off natively, whatever the app sends.
- Swift computes this once per frame for at most 2 × 128 holds and binds it as fragment buffer 5; the shader reads one `ushort4` per candidate hold. With no look the shader takes API 7's path, byte-identical to before (checked by `scripts/board-motion-preview`).
- The look's numbers are the `swapLook` view prop, set when a slider is released. Each frame adds two numbers to the swap frame (seven with the sequence): whether the climb being left and the arriving one use the arriving rules. A climb takes them when it shows up as the incoming climb and drops them only at weight 0 or 1. The fourth number is then the floor below which shared holds never go; a commit within the flick-run window eases it to 1.
- To see a variant without a phone, `scripts/board-motion-preview/README.md` renders ten frames of each on the Mac's GPU with the real shader.

## Scripts and Play all

`scripts.ts` holds the scripted swipes (`FINGER_SCRIPTS`) and the one `SHOWCASE_SCRIPT` that Play all runs. Play all is a hands-free demo: for each available variant it selects the variant (the caption switches), puts the board back on the set's first climb, waits up to 2 s for the board to report GPU or PNG, holds 800 ms, plays the showcase script, then rests 600 ms before the next. A script that never finishes is stopped at its length (at the chosen speed) plus 2 s. Every variant swipes the same climbs. Stop cancels it, or ends a single script.

A script drives the real swipe code through a virtual finger. The board takes no touches while one plays, and a zoomed board is zoomed back out first, since a zoomed board refuses the swipe. With no board to swipe (no bundled art, no climbs) a script ends at once. Each run plays once: changing variant, a slider, speed or Reduce Motion mid-script ends the run where it is (the board is rebuilt for the new transition) and never replays it.

### What speed slows down

At 0.5× and 0.25× only two things slow down: the transition's own clocks (the swap and the settle) and the scripted finger. The swipe's settle spring still runs at real speed. That is the fling after a release, which moves the header to the next climb and tells the swap the climb has arrived (about 90 to 200 ms). So a slowed run is not a slowed copy of the 1× run: the climb arrives sooner relative to the finger and the swap. "Flick again mid-swap" shows it most: at 1× its second touch takes over a fling still running (the #7750 case), at 0.25× it lands 320 ms after the first release, when that fling has long landed, which is a different path. Judge that script at 1×. Release velocities are not scaled, so every speed commits the same swipes.

## Build to a phone

- Debug: `vp run mobile:ios -- --device <udid>`
- Release: `vp run mobile:ios -- --device <udid> --configuration Release`. No special env is needed.

The iOS Simulator reports native API 1, so it draws PNG and can't show GPU motion. Use a real phone or an Android emulator.
