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
| `Climb View Opened`            | `climb_uuid`, `reopened_in_session`                    | `markClimbViewed`, called from `setCurrentClimb` in `queue-provider.tsx` (beside `Set Active Climb`) |
| `Board Pinch`                  | `scale_max`                                            | `noteBoardPinch`, called from `use-zoom-pan-gesture.ts`'s pinch `onEnd` (via `SwipeBoardCarousel`'s `boardRenderTelemetryProps`) |
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
- **`markClimbAction(climbUuid, actionType)`** — fires `Climb First Action`
  **at most once per `markClimbViewed` call**, with `ms_since_open` measured
  from that view's open time. A no-op when the climb was never marked viewed
  (a queue add straight from search, with no prior climb view) or the view
  already actioned. The common props travel with the view state, captured at
  `markClimbViewed` time — so a call site far from any board context (a BLE
  send success callback, which only has a `climbUuid` in its `sendContext`)
  still fires a fully-populated event.
- **`noteBoardPinch(commonProps, { scaleMax, scaleDelta })`** — independent of
  the view state machine (a pinch needs no prior "view" bookkeeping). Gated on
  `Math.abs(scaleDelta) >= 0.15`: a pinch that barely moved the scale is finger
  jitter on an otherwise-static touch, not a deliberate zoom, and would
  otherwise inflate the pinch count with noise. The CALLER is responsible for
  invoking this once per gesture end, never per frame — see the gesture-hook
  note below.

## The pinch gesture: once per gesture end, never per frame

`use-zoom-pan-gesture.ts`'s pinch `Gesture.Pinch()` tracks the gesture's peak
absolute scale (`pinchScaleMaxSV`, a Reanimated shared value) on the UI thread
during `onUpdate` — cheap arithmetic, no bridge crossing. The ONE bridge hop
happens at `onEnd`, via the same `runOnJS` pattern the existing
`updateZoomState` call already uses: `handlePinchEnd(scaleMax, scaleDelta)`
runs on the JS thread exactly once per gesture, and only then does
`noteBoardPinch` get called (guarded on `boardRenderTelemetryProps` being
set — the two other `useZoomPanGesture` callers, `InteractiveCreateBoard.tsx`
and `InteractiveFilterBoard.tsx`, don't pass it, so their pinches fire nothing).

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
   - `board-render-mode-default` — variants `classic` / `boardsesh`. Ship at
     **0% `boardsesh`** initially (mobile's own shipped default already reads
     `classic` when the flag is unresolved, so 0% is a no-op rollout, not a
     silent behaviour change).
   - `board-glow-falloff` — variants `soft` / `plateau`.
2. **An Experiment on `board-glow-falloff`**, 50/50 `soft` / `plateau`,
   **scoped to `render_mode = boardsesh`** — the falloff only reaches climbers
   the mode flag (or their own Settings choice) already put on the Boardsesh
   drawing, so an unscoped experiment would dilute its own sample with
   `classic` climbers who can never see the property it's testing.
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
