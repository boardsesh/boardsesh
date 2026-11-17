# Board motion lab

A dev screen for comparing ways to change climbs on the player's GPU board. It draws the real player board, lets sliders retune a transition live, and plays the same scripted swipes for every variant, so two phones record identical input.

## Who can open it

Dev builds, testers and admins: the same people who see the dev tools on Settings > Developer. Everyone else who reaches the route is sent back to Settings. The lab ships in normal builds; its screen is only loaded when the route opens.

## Open it

- Settings > Developer > Board motion lab.
- Deep link: `com.boardsesh.app://settings/board-motion-lab?variant=<id>&board=<id>&set=<id>&speed=0.25&autoplay=all&reduceMotion=on`.
  - `variant`: a variant id. `board`: a board id from `fixtures.ts`. `set`: `real`, `none`, `half`, `mostly` or `role-change`.
  - `speed`: `1`, `0.5` or `0.25`. `reduceMotion`: `system`, `on` or `off`.
  - `autoplay`: `all` or one variant id.

## Screen

Caption bar (letter, variant name, speed, board), the board, a status line (`GPU · API 7 · prepare 42 ms`, `PNG · <reason>` or `Loading…`), then controls: Play script, Play all variants, variant, speed, Reduce Motion, one slider per parameter (committed on release), Copy params, Reset params, script, board, climb set. Variants that need a newer native API than the build has are greyed out with the reason. There is no light/dark toggle; the lab follows the system theme.

## Add a variant

One file in `src/components/board-motion-lab/variants/` exporting a `BoardMotionVariant` (see `types.ts`), plus one line in `variants/index.ts`. Its `params` become sliders; `createTransition(params)` returns the transition the carousel uses.

## Scripts and Play all

`scripts.ts` holds the scripted swipes (`FINGER_SCRIPTS`) and the one `SHOWCASE_SCRIPT` that Play all runs. Play all is a hands-free demo: for each available variant it selects the variant (the caption switches), puts the board back on the set's first climb, waits up to 2 s for the board to report GPU or PNG, holds 800 ms, plays the showcase script, then rests 600 ms before the next. Every variant swipes the same climbs. Stop cancels it, or ends a single script.

A script drives the real swipe code through a virtual finger. The board takes no touches while one plays. Each run plays once: changing variant, a slider, speed or Reduce Motion mid-script ends the run where it is (the board is rebuilt for the new transition) and never replays it.

### What speed slows down

At 0.5× and 0.25× only two things slow down: the transition's own clocks (the swap and the settle) and the scripted finger. The swipe's settle spring still runs at real speed. That is the fling after a release, which moves the header to the next climb and tells the swap the climb has arrived (about 90 to 200 ms). So a slowed run is not a slowed copy of the 1× run: the climb arrives sooner relative to the finger and the swap. "Flick again mid-swap" shows it most: at 1× its second touch takes over a fling still running (the #7750 case), at 0.25× it lands 320 ms after the first release, when that fling has long landed, which is a different path. Judge that script at 1×. Release velocities are not scaled, so every speed commits the same swipes.

## Build to a phone

- Debug: `vp run mobile:ios -- --device <udid>`
- Release: `vp run mobile:ios -- --device <udid> --configuration Release`. No special env is needed.

The iOS Simulator reports native API 1, so it draws PNG and can't show GPU motion. Use a real phone or an Android emulator.
