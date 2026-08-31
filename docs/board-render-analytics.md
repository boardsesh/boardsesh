# Board render analytics

The event contract for the classic-vs-Boardsesh drawing A/B and the
Boardsesh glow-falloff A/B (issue #2202) — mobile only today.

Source of truth: `packages/shared/analytics/src/board-render-events.ts`,
re-exported from `@boardsesh/analytics`. Tests:
`packages/shared/analytics/src/__tests__/board-render-events.test.ts` and
`packages/mobile/src/lib/__tests__/climb-view-session.test.ts`
(`vp test run --project analytics --reporter=agent` /
`vp run test:mobile`).

## How to fire an event

Never write an event name as a string literal, and never destructure a
builder's return value apart. The mobile call surface is three small wrapper
functions in `packages/mobile/src/lib/climb-view-session.ts` — call those, not
the shared builders directly, unless you're adding a new call site the wrappers
don't cover yet (a settings-screen change, say):

```ts
import { buildBoardRenderTelemetryProps } from '@boardsesh/analytics';
import { markClimbViewed } from '../lib/climb-view-session';

const commonProps = buildBoardRenderTelemetryProps(effectiveRenderSettings, {
  boardName,
  layoutId,
  sizeId,
});
markClimbViewed(climbUuid, commonProps);
```

`buildBoardRenderTelemetryProps` is the ONE place the common props get
assembled. Every builder in `board-render-events.ts` takes its output (plus its
own extra fields) as input, so a call site cannot drop `board_name` or hand-roll
a differently-cased duplicate — and a builder always returns `{ name,
properties }` together, so a caller cannot pair one event's props with another
event's name.

## The five events

| Event                          | Extra properties (beyond the common ones)             | Fired by                                                                            |
| ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Climb View Opened`            | `climb_uuid`, `reopened_in_session`, plus `$feature_flag` / `$feature_flag_response` on an exposure | `markClimbViewed`, from the current-climb effect in `queue-provider.tsx` and the play drawer's preview latch |
| `Board Pinch`                  | `scale_max`, `scale_min`, `scale_delta` (signed)       | `noteBoardPinch`, called from `use-zoom-pan-gesture.ts`'s pinch `onEnd` (via `SwipeBoardCarousel`'s `boardRenderTelemetryProps`) |
| `Climb First Action`           | `climb_uuid`, `action_type` (`'queue'` \| `'ble'`), `ms_since_open` | `markClimbAction`, called from `commitQueueAdd` in `queue-provider.tsx` (`'queue'`) and the three `ClimbSentToBoardSuccess` sites in `use-board-bluetooth.ts` (`'ble'`) |
| `Board Render Settings Changed`| `field`, `value`                                       | The settings screen (issue #2202, parallel PR) — not wired yet in this PR |
| `Board Render Preset Applied`  | none — the common props ARE the event                  | The settings screen's preset/palette pickers (issue #2202, parallel PR) — not wired yet in this PR |

### The common properties every event carries

Built by `buildBoardRenderTelemetryProps(effective, context)`:

| Property               | Values                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `board_name`            | e.g. `kilter`, `tension`, `moonboard`, `woods`, `grasshopper`   |
| `layout_id`             | number                                                          |
| `size_id`               | number                                                          |
| `render_mode`           | `classic` \| `boardsesh` — the drawing this render actually used |
| `glow_falloff`          | `soft` \| `plateau`                                             |
| `glow_falloff_source`   | `user` \| `flag` \| `default` — where the falloff answer came from |
| `preset_id`             | optional; absent (not `undefined`) until the settings-screen presets PR ships |
| `palette_id`            | optional; absent until the CVD palette presets PR ships          |

### The two exposure properties on `Climb View Opened`

| Property                 | Values                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `$feature_flag`           | `board-glow-falloff` — present only on an exposure             |
| `$feature_flag_response`  | `soft` \| `plateau` — the variant this render actually drew    |

Both are attached by the `climbViewOpened` builder, and only when
`render_mode = boardsesh` AND `glow_falloff_source = 'flag'`. They are what
lets PostHog read `Climb View Opened` as the experiment's exposure event — see
the PostHog setup section below.

`render_mode`, `glow_falloff` and `glow_falloff_source` are ALSO registered as
PostHog super properties (`registerRenderSuperProperties` in
`packages/mobile/src/lib/analytics.ts`, called from a `useEffect` in
`queue-provider.tsx` whenever `effectiveRenderSettings` changes) — mirroring
the existing `connectivity` / `offline_engine_state` super properties. That
means every OTHER event fired for the rest of the launch, not just the five
above, can be sliced by which drawing and which falloff this climber is on.

## The builder rule

Every property in this module is **snake_case**, unlike the gym funnel's
camelCase (`docs/gym-funnel-analytics.md`) — deliberately, because these
property names have to match the super property names verbatim
(`render_mode`, `glow_falloff`, `glow_falloff_source`) for a dashboard built
against one to read the other the same way. If you add a sixth event, keep
that convention: snake_case properties, and spread the common props' output
directly rather than re-deriving `board_name` / `render_mode` / etc. by hand.

`BoardRenderPayload<TName, TProperties>` constrains `TProperties` to
`AnalyticsEventProperties` (allows `| undefined`), not the narrower
`AnalyticsPropertyValue` the gym funnel uses — `preset_id` / `palette_id` are
optional, and `track()` already expects exactly this shape.

## Why this IS in `SHARED_EVENTS`

Unlike the gym funnel (which is www-only and lives in its own module,
`gym-funnel.ts`, specifically to stay out of `SHARED_EVENTS`), the five event
names here live in `packages/shared/analytics/src/events.ts`'s
`SHARED_EVENTS`. Mobile fires every one of them today, and nothing here is
platform-exclusive the way the gym directory / claim flow / manage console
are — a future web board-render surface (there is none today; see
`docs/expo-web-migration-decision.md`, board rendering moved to the Expo app)
would reuse the same names and property shape rather than minting a second
funnel.

## `climb-view-session.ts` — the mobile session state machine

`packages/mobile/src/lib/climb-view-session.ts` is a plain module-level
singleton (state lives for the JS run, reset by `_resetClimbViewSessionForTests`
in tests, or an app relaunch). Three entry points:

- **`markClimbViewed(climbUuid, commonProps)`** — opens a "view" for this
  climb and fires `Climb View Opened`. `reopened_in_session` is `true` the
  second (and every later) time the SAME climb uuid is passed this app run —
  a `Set` per app run, not per view — so a query can separate a genuinely
  fresh climb view from a climber swiping back to one they already had open.
  Opening a view **closes the previous one**: exactly one view is open at a
  time, because exactly one climb is on the board at a time. Re-reporting the
  climb that is already open is a **no-op** — see "Two reporters" below.
- **`markClimbAction(climbUuid, actionType)`** — fires `Climb First Action`
  **at most once per `markClimbViewed` call**, with `ms_since_open` measured
  from that view's open time. A no-op when the climb is not the open view (a
  queue add straight from search with no prior climb view, or an action on a
  climb that left the board a while ago) or the view was already actioned. The
  common props travel with the view state, captured at `markClimbViewed` time —
  so a call site far from any board context (a BLE send success callback, which
  only has a `climbUuid` in its `sendContext`) still fires a fully-populated
  event.
- **`noteBoardPinch(commonProps, { scaleMax, scaleMin, scaleDelta })`** —
  independent of the view state machine (a pinch needs no prior "view"
  bookkeeping). Gated on `Math.abs(scaleDelta) >= 0.15`: a pinch that barely
  moved the scale is finger jitter on an otherwise-static touch, not a
  deliberate zoom, and would otherwise inflate the pinch count with noise. The
  CALLER is responsible for invoking this once per gesture end, never per
  frame — see the gesture-hook note below.

### One open view at a time

`ms_since_open` is only meaningful if the view it measures from is the one the
climber was actually looking at. A per-climb map of open views broke that: view
climb X, browse for twenty minutes, then tap X again under Similar Climbs —
where `addToQueue` runs BEFORE `setCurrentClimb` — and the queue add matched the
twenty-minute-old view, reporting
`Climb First Action { ms_since_open: ~1_200_000 }`. A single slot makes that
impossible: the queue add lands while some other climb's view is open, matches
nothing, and fires nothing; the `setCurrentClimb` right after it opens a fresh
view, and the next action is measured from there.

The clock is `performance.now()`, not `Date.now()`. Wall-clock time is not
monotonic — an NTP correction mid-session can move it backwards and emit a
negative `ms_since_open`.

## What counts as a view

A view is **the climb drawn on the board changing**, not the call that changed
it. `queue-provider.tsx` fires it from a `useEffect` keyed on the current queue
item's uuid and its climb uuid, so every path lands the same way:

- a tap that activates a climb (`setCurrentClimb`),
- a swipe (`nextClimb` / `previousClimb`, which dispatch to the reducer
  directly and never pass through `setCurrentClimb` — the first cut of this
  event fired inside that callback and therefore missed the single most common
  way a climber moves between climbs),
- a widget Next/Previous,
- a **party peer** advancing the queue. That counts on purpose: a crew member's
  navigation puts a climb on this climber's board, and it is the drawn climb
  the A/B measures.
- a hydrated queue on app open, for the same reason: the restored climb is what
  they see when the drawer comes up.

Neither key changes when a thin peer item merely hydrates, so hydration doesn't
double-count. Re-tapping the climb that is already current mints a fresh
queue-item uuid and DOES count — that is a deliberate fresh pass.

The play drawer's preview latch is the one surface that draws a climb without
touching the queue (swiping while a preview is pinned, or a signed-out reader
tapping through Similar Climbs). It reports those itself through
`noteClimbViewed`, a stable action on the queue context.

### Two reporters, one view

Those two reporters overlap on purpose. Committing a pinned preview
("Put on the wall") calls `setCurrentClimb` with the climb the drawer was
already showing, so the provider's effect would report a second view for a
climb nothing redrew. `markClimbViewed` therefore no-ops when the uuid handed
to it is already the open view: a second view there would inflate the
denominator of every per-view rate and reset `ms_since_open` on a climb the
climber never looked away from. Coming BACK to a climb still counts — some
other climb has to have been on the board in between.

### Cold start: a deferred view beats a mislabelled one

`queue-provider.tsx` holds the view back while `renderSettingsPending` — either
the climber's own stored settings haven't come back from AsyncStorage, or the
mode being asked for is `boardsesh` and the native capability probe hasn't
answered yet (`getBoardseshRendererSupport() === null`, which resolves to
`classic` for safety). Both windows are cold-start-only and both self-clear: the
provider subscribes to the capability store, so the effect re-runs and fires
once the answer lands, with the resolved mode. A mislabelled view is worse than
a late one — it lands in the wrong arm of the A/B the event exists to measure.

One limitation this does NOT cover: PostHog's own flag resolution. On a first
cold launch with no cached flag payload, `board-render-mode-default` is
unresolved and reads as `classic`. That view is labelled `classic` and its
`glow_falloff_source` is `default`, so it is never counted as an exposure — the
experiment isn't corrupted, it just doesn't see that first view. Gating on flag
resolution instead would mean firing nothing at all for a climber who is
offline, which is worse.

## The pinch gesture: once per gesture end, never per frame

`use-zoom-pan-gesture.ts`'s pinch `Gesture.Pinch()` tracks the gesture's peak
AND lowest absolute scale (`pinchScaleMaxSV` / `pinchScaleMinSV`, Reanimated
shared values) on the UI thread during `onUpdate` — cheap arithmetic, no bridge
crossing. The ONE bridge hop happens at `onEnd`, via the same `runOnJS` pattern
the existing `updateZoomState` call already uses:
`handlePinchEnd(scaleMax, scaleMin, scaleDelta)` runs on the JS thread exactly
once per gesture, and only then does `noteBoardPinch` get called (guarded on `boardRenderTelemetryProps` being
set — the two other `useZoomPanGesture` callers, `InteractiveCreateBoard.tsx`
and `InteractiveFilterBoard.tsx`, don't pass it, so their pinches fire nothing).

`scale_delta` is **signed**: `scale.value - savedScale.value` at `onEnd`, i.e.
where the gesture finished minus where it started. The first cut reported
`scaleMax - savedScale` instead, which is exactly 0 for every gesture that only
zooms OUT (a zoom-out never exceeds its own starting scale), so the 0.15 jitter
gate threw all of them away — the event counted zoom-ins only. `scale_max` and
`scale_min` carry the gesture's true extremes on top, so a query can tell
"zoomed in, then released back out" apart from "pulled straight out".

`boardRenderTelemetryProps` itself is read through a `ref`, not listed as a
gesture dependency — an object that churns identity every render would
recompose the pinch/pan gestures mid-session, which has broken RNGH on iOS
before (see the existing `enabledSV` / `containerWidthSV` mirrors in the same
file). `SwipeBoardCarousel.tsx` memoizes the props object on
`effectiveRenderSettings` + the board identity, so its identity only changes
when the resolved drawing itself changes.

## Stratification: never pool

**Always split by `board_name`.** Boards differ enough in art, hold density
and photo busyness that a glow-falloff or render-mode effect on one board can
point the opposite direction on another — Grasshopper's busy photo and a bare
MoonBoard grid are not comparable renders, and pooling them into one number
erases whichever direction is the minority board.

**Always split by `glow_falloff_source`.** Only `mode = boardsesh` climbers
have a `glow_falloff` at all, and among those, `glow_falloff_source: 'user'`
(a climber who picked a falloff in Settings) is a self-selected population —
they are not a random sample of `boardsesh` climbers, and mixing them into the
`'flag'` cohort (the actual A/B) will bias the comparison toward whatever the
opinionated minority prefers. Read the experiment ONLY on
`glow_falloff_source = 'flag'`.

**Never compare `Climb First Action`'s `ms_since_open` across `render_mode`
without also fixing `board_name`.** A faster commit time on `boardsesh` could
be the drawing, or it could be that the `boardsesh` cohort happened to be
disproportionately on boards climbers already know well. Fix the board before
reading the time.

## PostHog setup (not done yet — lead does this after confirming with the maintainer)

Nothing has been created in PostHog by this PR. When ready:

1. **Two multivariate feature flags**, both matching the mobile catalog
   exactly (`packages/mobile/src/providers/feature-flags-provider.tsx`):
   - `board-render-mode-default` — variants `classic` / `boardsesh`.
     **For the 2.4 store release this ships at 100% `boardsesh`** — the
     Boardsesh drawing is the default a climber gets, and Classic stays one tap
     away under More > Board look > Render. Create the flag at **0%
     `boardsesh`** first and ramp it only once the 2.4 binary is live in both
     stores: mobile's shipped default reads `classic` when the flag is
     unresolved, so 0% is a no-op rollout rather than a silent behaviour
     change, and a climber on an older binary that cannot draw the mode is
     pinned to Classic by the capability probe regardless of the flag. A
     climber's own Settings choice always beats the flag in both directions.
   - `board-glow-falloff` — variants `soft` / `plateau`.
2. **An Experiment on `board-glow-falloff`**, 50/50 `soft` / `plateau`, with
   **`Climb View Opened` as a CUSTOM EXPOSURE EVENT**, filtered to
   `render_mode = boardsesh`.

   In the experiment's setup, open **Configure exposure criteria** (the default
   is "Default — `$feature_flag_called`") and switch it to a custom event:
   - Event: `Climb View Opened`
   - Property filter: `render_mode` equals `boardsesh`

   PostHog reads the variant off the event's own `$feature_flag` /
   `$feature_flag_response` properties, which the `climbViewOpened` builder
   attaches whenever the render is `boardsesh` AND the falloff came from the
   flag (`glow_falloff_source = 'flag'`). The `render_mode` filter is belt and
   braces — the builder already withholds the exposure properties otherwise —
   but it also keeps the exposure COUNT honest on the results page.

   **`$feature_flag_called` is intentionally never sent on mobile.** Every flag
   read goes through `READ_WITHOUT_EXPOSURE_EVENT` (`sendEvent: false`) in
   `packages/mobile/src/lib/analytics.ts`, because `FeatureFlagsProvider`
   re-reads the whole catalog on every flags-changed tick and leaving exposure
   events on cost ~173k events / 30 days — 13% of the project's entire volume,
   for a signal nothing consumed. Do NOT flip that flag back on to run this
   experiment; the custom exposure event above costs nothing extra and is a
   truer definition of exposure anyway — a climber is exposed to a glow-falloff
   variant exactly when a climb is drawn in front of them on the Boardsesh
   drawing.

   Why `render_mode = boardsesh` scoping matters at all: the falloff only
   reaches climbers the mode flag (or their own Settings choice) already put on
   the Boardsesh drawing, so an unscoped experiment would dilute its own sample
   with `classic` climbers who can never see the property it's testing. And why
   the builder also requires `glow_falloff_source = 'flag'`: a climber who
   picked a falloff in Settings is self-selected, not randomised — counting
   them as exposed would attribute their outcomes to the variant they chose for
   themselves.
3. **Goal metrics, one set per board** (see the stratification rule above):
   - `Climb First Action` rate (of `Climb View Opened`), split by
     `action_type`.
   - `Climb First Action`'s `ms_since_open`, median/p90.
   - `Board Pinch` rate (of `Climb View Opened`) — a proxy for "the climber
     needed to zoom in to read the wall", which a clearer drawing should
     reduce.
4. Once `board-render-mode-default` ramps past 0%, add board-level goal
   metrics for it too (same three, split by `render_mode` instead of
   `glow_falloff`), scoped to `glow_falloff_source != 'user'` so a climber's
   own opinionated falloff choice doesn't leak into the mode comparison.
