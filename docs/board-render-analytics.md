# Board render analytics

The event contract for the classic-vs-Aura drawing A/B and the
Boardsesh glow-falloff A/B (issue #2202) — mobile only today.

Source of truth: `packages/shared/analytics/src/board-render-events.ts`,
re-exported from `@boardsesh/analytics`. Tests:
`packages/shared/analytics/src/__tests__/board-render-events.test.ts`,
`packages/mobile/src/lib/__tests__/climb-view-session.test.ts` and
`packages/mobile/src/hooks/__tests__/use-native-climb-render-failure-telemetry.test.tsx`
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

## The eight events

| Event                          | Extra properties (beyond the common ones)             | Fired by                                                                            |
| ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Climb View Opened`            | `climb_uuid`, `reopened_in_session`, plus `$feature_flag` / `$feature_flag_response` on an exposure | `markClimbViewed`, from the current-climb effect in `queue-provider.tsx` and the play drawer's preview latch |
| `Board Pinch`                  | `scale_max`, `scale_min`, `scale_delta` (signed)       | `noteBoardPinch`, called from `use-zoom-pan-gesture.ts`'s pinch `onEnd` (via `SwipeBoardCarousel`'s `boardRenderTelemetryProps`) |
| `Climb First Action`           | `climb_uuid`, `action_type` (`'queue'` \| `'ble'`), `ms_since_open` | `markClimbAction`, called from `commitQueueAdd` in `queue-provider.tsx` (`'queue'`) and the three `ClimbSentToBoardSuccess` sites in `use-board-bluetooth.ts` (`'ble'`) |
| `Board Render Settings Changed`| `field`, `value`                                       | Two places: the board-look carousel's Classic card, on both surfaces (Classic is a mode change, not a preset); and every hand adjustment on a Board look screen, via `setMode` / `setBoardseshField` in `use-board-look-settings.ts` — the one writer, so a knob cannot be wired up and miss the event. Silent when there is no preview board to report against, since the common props are built around a board identity. |
| `Board Render Preset Applied`  | `surface` (`'settings'` \| `'onboarding'`, optional) — otherwise the common props ARE the event | `trackBoardLookApplied` in `packages/mobile/src/lib/board-render/board-look-analytics.ts`, from the board-look carousel on both its surfaces |
| `Board Look Step Shown`        | `options_shown`                                        | The one-time board-look step (`BoardLookStep.tsx`), once per presentation |
| `Board Look Step Resolved`     | `outcome` (`'saved'` \| `'customized'` \| `'skipped'`), `selected_option`, `cards_viewed`, `ms_to_resolve` | The same step — exactly once per Shown, including the unmount-without-choosing path |
| `Board Render Failed`          | `surface`, `stage`, `failure_kind`, `error_code`, `render_width`, `frames_length`, `failures_this_session`, plus `lit_count` / `unmatched_count` on the config stage | `noteRenderFailure` in `packages/mobile/src/hooks/use-native-climb-render.ts` — the hold-match check before the render, the native render's `.catch` (real failures and the capability fallbacks), `reportOverlayLoadFailure` (every expo-image load failure) and the paint watchdog |

### The common properties every event carries

Built by `buildBoardRenderTelemetryProps(effective, context)`:

| Property               | Values                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `board_name`            | e.g. `kilter`, `tension`, `moonboard`, `woods`, `grasshopper`   |
| `layout_id`             | number                                                          |
| `size_id`               | number                                                          |
| `render_mode`           | `classic` \| `aura` — the drawing this render actually used. Was `boardsesh` before 2.4; see the value history below |
| `glow_falloff`          | `soft` \| `plateau`                                             |
| `glow_falloff_source`   | `user` \| `default` — whether the climber picked the curve or took the shipped one |
| `preset_id`             | optional; absent (not `undefined`) when the event is not about a preset |
| `palette_id`            | optional; absent until the CVD palette presets are wired         |

### No exposure properties any more

`Climb View Opened` used to carry PostHog's `$feature_flag` /
`$feature_flag_response` so it could serve as the glow-falloff experiment's
exposure event. That experiment is gone with `board-glow-falloff`, so the event
carries only its own properties.

If an experiment is run here again, mint the exposure on an event we already
send rather than turning `$feature_flag_called` back on: mobile reads every flag
with `sendEvent: false` because the provider re-reads the whole catalog on every
flags-changed tick, and leaving exposures on cost ~173k events / 30 days — 13%
of the project's volume.

`render_mode`, `glow_falloff` and `glow_falloff_source` are ALSO registered as
PostHog super properties (`registerRenderSuperProperties` in
`packages/mobile/src/lib/analytics.ts`, called from a `useEffect` in
`queue-provider.tsx` whenever `effectiveRenderSettings` changes) — mirroring
the existing `connectivity` / `offline_engine_state` super properties. That
means every OTHER event fired for the rest of the launch, not just the ones
above, can be sliced by which drawing and which falloff this climber is on.

## `Board Render Failed` — when the board does not draw

Every other event on this page describes a render that worked. This one is the
opposite, and it was added because a render that fails is otherwise invisible:
the native rejection was a `console.warn` plus one Sentry event per failure kind
per JS lifetime, the expo-image load failures were the same, and no dashboard
had anything at all. A session where every render failed after the seventh swipe
(the Aura 12x12 blank-overlay report) looked exactly like a session that never
failed.

It fires from four places, all in
`packages/mobile/src/hooks/use-native-climb-render.ts`:

- the hold-match check, run just before the native call (see "The config stage"
  below) — the only failure here that never throws;
- the native render's `.catch`, for every rejection — including the capability
  fallbacks that Sentry is deliberately never told about (#4240);
- `reportOverlayLoadFailure`, the single writer behind every `onOverlayError`
  path, so a load failure cannot be handled without being counted;
- the paint watchdog, for an overlay expo-image never answered about.

### Properties

Common props (the table above) plus:

| Property                | Values                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `surface`               | `full` \| `thumbnail` — the play board or a list / accessory thumbnail (the hook's `filledStyle`)                                          |
| `stage`                 | `config` \| `native` \| `image_load` — which part of the path gave up                                                                       |
| `failure_kind`          | on `config`: `no_matching_holds` \| `partial_hold_match`. On `native`: `render_failed` \| `disk_full` \| `capability_fallback`. On `image_load`: `cache_entry_missing` \| `retry_exhausted` \| `cache_entry_present` \| `validation_failed` \| `validation_unsupported` \| `paint_timeout` |
| `error_code`            | `code_<n>` \| `png` \| `cgimage` \| `write` \| `module` \| `capability` \| `no_matching_holds` \| `paint_timeout` \| `other`                  |
| `render_width`          | requested overlay width in pixels, or `null` for a native-width render                                                                     |
| `frames_length`         | length of the frames string — a cheap proxy for climb complexity                                                                          |
| `failures_this_session` | running count for this JS lifetime, INCLUDING this event                                                                                   |
| `lit_count`             | config stage only: how many placements frame 0 lights. A count, never the ids — the ids are the climb                                     |
| `unmatched_count`       | config stage only: how many of those the board config has no hold for                                                                     |

`stage` and `failure_kind` are one discriminated pair in
`BoardRenderFailedInput`, not two free fields: a native rejection can never be
`retry_exhausted` and an image load can never be `disk_full`. Pairing them in the
type is what stops a call site inventing a combination no query would match.

### `error_code` is a bucket, never the message

The failure message interpolates the cache key, the cache path and — on iOS — OS
prose in whatever language the phone is set to. None of that may be sent: the
cache key identifies the climb, and a message-shaped property would shatter the
event into one group per file, which is the exact mistake that once split one
device's disk-full storm across three Sentry issue groups (#3647).

`classifyBoardRenderErrorCode` (in `board-render-events.ts`) is the whole
boundary. A numeric code the native layer named wins over everything else and is
normalised (`code -002` → `code_-2`); otherwise the message is bucketed by shape.
Overlay filenames are stripped BEFORE the prose match, because every iOS write
failure carries `"v5_<key>.png"` and a bare `png` test would swallow the entire
`write` bucket.

### The config stage: the failure that never throws

Confirmed on the Android emulator, and the reason the event needed a stage
rather than just a failure kind. When a climb's `frames` name placement ids the
board config has no holds for — a Kilter Homewall climb (ids 4000+) opened under
Kilter Original 12x12 (ids 1080–1590) — the Rust renderer drops every unmatched
hold and returns **Ok**. The promise resolves, the PNG is written and cached,
and the climber gets a veil with nothing drawn on it. No rejection, no log, no
catch to hang telemetry off. So the check runs BEFORE the native call: parse
frame 0's lit ids (`parseLitHoldIds`, the one frames grammar) and intersect them
with the config's hold ids.

- `no_matching_holds` (nothing would draw): report and **skip the render**.
  Rendering would cache a blank overlay under that key, making the same failure
  quieter on every later visit. The overlay stays null and the wall photo still
  shows — the existing missing-layer contract.
- `partial_hold_match` (some draw, some do not): report and **render anyway**.
  A climb that legitimately reaches past a smaller layout loses the holds off
  the edge and keeps the rest, which is degraded, not blank.

### The paint watchdog

The remaining iOS suspect is a correctly rendered file that expo-image never
paints: the same climbs draw fine on Android and on the host, so the PNG is not
the problem. expo-image is supposed to answer with `onLoad` or `onError`;
silence is a third outcome nothing was watching for.

So the full-size board (`filledStyle === false` only — a list would arm one timer
per visible row) starts a 4s timer when it hands expo-image an overlay, cancelled
by `onOverlayLoad` for that exact load key, by `onOverlayError`, by the load key
changing, or by unmount. If it fires, `failure_kind: 'paint_timeout'`.

**Observation only.** The overlay is not nulled and nothing is retried. A file
that renders correctly but never paints is a different fault from one that
failed to load, and handling it as the latter — null the overlay, spend the
once-per-key retry budget — is exactly what would hide it again.

### The 25-event session cap

The hook counts every failure in a module-scoped counter and stops firing after
25 per JS lifetime. The failure this event exists for is a device that fails
EVERY render from some point on, and `getOrStartInflightRender` drops the settled
promise, so every recycled FlashList row tries again — the storm shape from
#3647. 25 events is plenty to see which stage, kind and code a session is stuck
on. Past the cap nothing is sent but `failures_this_session` keeps counting, so
a stream that stops at 25 reads as truncated rather than as a device that failed
exactly 25 times.

Sentry keeps its own, tighter budget — one report per failure kind per lifetime —
and now carries `failuresThisSession` in `extra` plus a `board-render` breadcrumb
for every failure, so the single report it does send can say whether it was a
one-off or the first of hundreds.

### Reading it

Stratify the same way as everything else on this page: never pool across
`board_name`, and never pool `render_mode`. Two useful reads:

- failures per `Climb View Opened`, split by `board_name` × `render_mode` — the
  Aura-vs-classic question the original report raised;
- `stage` × `failure_kind` × `error_code` for one board, which is what separates
  "this climb does not belong to this board" from "the renderer is rejecting"
  from "the PNG will not load back" from "iOS never painted it".

## The builder rule

Every property in this module is **snake_case**, unlike the gym funnel's
camelCase (`docs/gym-funnel-analytics.md`) — deliberately, because these
property names have to match the super property names verbatim
(`render_mode`, `glow_falloff`, `glow_falloff_source`) for a dashboard built
against one to read the other the same way. If you add another event, keep
that convention: snake_case properties, and spread the common props' output
directly rather than re-deriving `board_name` / `render_mode` / etc. by hand.

`BoardRenderPayload<TName, TProperties>` constrains `TProperties` to
`AnalyticsEventProperties` (allows `| undefined`), not the narrower
`AnalyticsPropertyValue` the gym funnel uses — `preset_id` / `palette_id` are
optional, and `track()` already expects exactly this shape.

## Why this IS in `SHARED_EVENTS`

Unlike the gym funnel (which is www-only and lives in its own module,
`gym-funnel.ts`, specifically to stay out of `SHARED_EVENTS`), the event
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
mode being asked for is `aura` and the native capability probe hasn't
answered yet (`getBoardseshRendererSupport() === null`, which resolves to
`classic` for safety). Both windows are cold-start-only and both self-clear: the
provider subscribes to the capability store, so the effect re-runs and fires
once the answer lands, with the resolved mode. A mislabelled view is worse than
a late one — it lands in the wrong arm of the A/B the event exists to measure.

One limitation this does NOT cover: PostHog's own flag resolution. On a first
cold launch with no cached flag payload, `board-glow-falloff` is unresolved and
reads as `soft`. That view's `glow_falloff_source` is `default`, so it is never
counted as an exposure — the experiment isn't corrupted, it just doesn't see
that first view. Gating on flag resolution instead would mean firing nothing at
all for a climber who is offline, which is worse.

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

**Always split by `glow_falloff_source`.** Only `mode = aura` climbers
have a `glow_falloff` at all, and among those, `glow_falloff_source: 'user'`
(a climber who picked a falloff in Settings) is a self-selected population —
they are not a random sample of `aura` climbers, and mixing them into the
`'flag'` cohort (the actual A/B) will bias the comparison toward whatever the
opinionated minority prefers. Read the experiment ONLY on
`glow_falloff_source = 'flag'`.

**Never compare `Climb First Action`'s `ms_since_open` across `render_mode`
without also fixing `board_name`.** A faster commit time on `aura` could
be the drawing, or it could be that the `aura` cohort happened to be
disproportionately on boards climbers already know well. Fix the board before
reading the time.

## PostHog setup (not done yet — lead does this after confirming with the maintainer)

Nothing has been created in PostHog by this PR. When ready:

1. **No feature flags.** Both board-render flags (`board-render-mode-default`,
   `board-glow-falloff`) were retired for 2.4: the Aura drawing is the app
   default and its glow curve is a climber-facing setting, so there is no
   rollout or experiment left to configure. `Climb View Opened` no longer
   carries PostHog's `$feature_flag` / `$feature_flag_response` exposure
   properties.

2. **Read `render_mode` and `glow_falloff` observationally, not as arms.** They
   are still on every event and still worth splitting by — but the populations
   are self-selected now (a climber on `classic` in 2.4 actively chose it), so
   treat any difference as a correlation, not a measured effect.

3. **Goal metrics, one set per board** (see the stratification rule above):
   - `Climb First Action` rate (of `Climb View Opened`), split by
     `action_type`.
   - `Climb First Action`'s `ms_since_open`, median/p90.
   - `Board Pinch` rate (of `Climb View Opened`) — a proxy for "the climber
     needed to zoom in to read the wall", which a clearer drawing should
     reduce.
4. `render_mode` is no longer an experiment arm — 2.4 ships Aura as the
   default for everyone who hasn't chosen otherwise. It stays a stratification
   dimension: read the three metrics above split by `render_mode` to compare
   the drawings observationally, remembering the populations self-selected
   (a climber on `classic` in 2.4 actively picked it) so this is not a
   randomised comparison.
5. **`glow_style` is gone.** It briefly split the Aura glow from the flat
   `plain` glow the drawing launched with. The knob was retired before 2.4
   shipped — `plain` lost on every board the glow lab measured, so keeping it
   only offered a worse render — and with it the property, both from the
   common props and from the render super-properties. Any saved insight
   filtering or breaking down on `glow_style` will silently match nothing
   after the cutover; drop the filter rather than re-adding the property.

## The board-look step (2.4)

The one-time step that asks a climber which drawing they want, now that Aura
is the app default. `Board Look Step Shown` and `Board Look Step
Resolved` are a **pair**: every Shown resolves to exactly one Resolved — saved,
customized, or skipped, the last of which also covers an unmount with no choice
at all. Without that pairing a climber who backed out would read in the funnel
as one who never arrived.

Two properties are worth naming:

- `cards_viewed` counts the DISTINCT cards that actually scrolled into view, not
  the number offered. A `saved` with one card viewed ("took the default on
  sight") and one with six ("swiped through, then chose") are different
  signals and must not be pooled.
- `selected_option` is `null` on a skip, and is the card id otherwise —
  including `'custom'`, whose apply also reports `preset_id: 'aura'`, because
  Custom lands the climber on the plain Aura bundle before opening the Board
  look screen. That is the ONBOARDING path. On the settings screen Custom does
  not apply a preset at all — it restores the climber's remembered bundle
  (`restoreCustomLook`) and reports from there, so the props describe the look
  that was restored rather than the Aura bundle. A first-time custom pick, where
  there is nothing remembered, still reports.

`outcome = 'skipped'` no longer means "accepted the default". The step became
mandatory in #4961 — there is no decline button, and the one-shot "seen" flag
is written only on an answer — so a `skipped` is a genuine abandon: a
force-quit or a nav-away, and that climber is asked again next launch. Read it
as a drop, and expect the same device to produce a later Shown.

### One cost worth knowing about

Retiring `board-render-mode-default` means every install now asks the native
library whether it can draw the Aura mode — `ensureBoardseshSupportProbed`
costs two renders, once per JS lifetime, and before the flip only the (0%) flag
cohort paid it. That is the price of the capability probe being the sole guard
between an older binary and a drawing it cannot produce.

## Value history (2.4 rename)

The board look was called *Boardsesh* until 2.4, when it became **Aura**. The
rename reached the identifiers, so three property values changed on the same
release. **Do not pool across the cutover** — a series that spans it has to be
read as two series, or filtered to one spelling.

| Property                          | Before 2.4                        | From 2.4                                  |
| --------------------------------- | --------------------------------- | ----------------------------------------- |
| `render_mode`                     | `boardsesh`                       | `aura`                                    |
| `preset_id` / `selected_option`   | `boardsesh`, `subtle`, `bold`     | `aura`, `aura-subtle`, `aura-bold`        |
| `glow_style`                      | `plain` \| `aura`                 | retired — no longer sent                   |

`classic`, `max-contrast`, `custom` and every other property are unchanged.

The rename reached the wire too: the Rust renderer, the native bridge, the
WASM build and the backend OG service all accept `render_mode: 'aura'` now, and
every committed renderer artifact was rebuilt in the same change. `'boardsesh'`
is no longer a valid value anywhere. Nothing had shipped to users on the old
spelling, so there is no compatibility window to keep open.

`native_artifact_contract.rs` gates this: it requires the `core/src/aura/`
module path in each committed binary, so an artifact that predates the rename
fails CI rather than silently answering `Unknown` and rendering every board
classic.
