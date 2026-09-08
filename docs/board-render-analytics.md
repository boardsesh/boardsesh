# Board render analytics

The event contract for the board-look surfaces and the render-failure signal
(issue #2202) — mobile only today.

The A/B this file was written for is over. `Climb View Opened`, `Board Pinch`
and `Climb First Action` were retired in the #2202 telemetry cleanup: both
rollout flags went away in 2.4, no saved insight, cohort or experiment ever
read the three events, and together they cost ~38.6k events a month. They are
no longer sent, and no builder, wrapper module or call site for them remains.
A query filtered on any of those three names matches nothing after the
cutover — drop the filter rather than re-adding the events.

Source of truth: `packages/shared/analytics/src/board-render-events.ts`,
re-exported from `@boardsesh/analytics`. Tests:
`packages/shared/analytics/src/__tests__/board-render-events.test.ts` and
`packages/mobile/src/hooks/__tests__/use-native-climb-render-failure-telemetry.test.tsx`
(`vp test run --project analytics --reporter=agent` /
`vp run test:mobile`).

## How to fire an event

Never write an event name as a string literal, and never destructure a
builder's return value apart. Build the common props, hand them to the builder
for the event you want, and track the pair:

```ts
import { boardRenderSettingsChanged, buildBoardRenderTelemetryProps } from '@boardsesh/analytics';

const commonProps = buildBoardRenderTelemetryProps(effectiveRenderSettings, {
  boardName,
  layoutId,
  sizeId,
});
const event = boardRenderSettingsChanged({ ...commonProps, field: 'glowFalloff', value: 'plateau' });
track(event.name, event.properties);
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
| `Board Render Settings Changed`| `field`, `value`                                       | Two places: the board-look carousel's Classic card, on both surfaces (Classic is a mode change, not a preset); and every hand adjustment on a Board look screen, via `setMode` / `setBoardseshField` in `use-board-look-settings.ts` — the one writer, so a knob cannot be wired up and miss the event. Silent when there is no preview board to report against, since the common props are built around a board identity. |
| `Board Render Preset Applied`  | `surface` (`'settings'` \| `'onboarding'`, optional) — otherwise the common props ARE the event | `trackBoardLookApplied` in `packages/mobile/src/lib/board-render/board-look-analytics.ts`, from the board-look carousel on both its surfaces |
| `Board Look Step Shown`        | `options_shown`                                        | The one-time board-look step (`BoardLookStep.tsx`), once per presentation |
| `Board Look Step Resolved`     | `outcome` (`'saved'` \| `'customized'` \| `'skipped'`), `selected_option`, `cards_viewed`, `ms_to_resolve` | The same step — exactly once per Shown, including the unmount-without-choosing path |
| `Board Render Failed`          | `surface`, `stage`, `failure_kind`, `error_code`, `render_width`, `frames_length`, `failures_this_session`, plus `lit_count` / `unmatched_count` on the config stage, plus `stall_state` / `queue_depth` / `dispatched_count` / `ms_waiting` on `render_stalled` | `noteRenderFailure` in `packages/mobile/src/hooks/use-native-climb-render.ts` — the hold-match check before the render, the native render's `.catch` (real failures and the capability fallbacks), `reportOverlayLoadFailure` (every expo-image load failure), the paint watchdog, and the render stall watchdog |

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

### No exposure properties anywhere

Nothing on this page is an experiment exposure. `Climb View Opened` was the
glow-falloff experiment's exposure event; the experiment retired with
`board-glow-falloff`, and the event itself is gone now too.

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
That super-property registration is now the main reason the provider resolves
the render settings at all.

`low_power_mode` (boolean) is a super property too, registered by
`LowPowerModeTracker` from expo-battery on launch and on every power-state
change, and restored after `analytics.reset()` like the others (issue #5187:
holds drew seconds late only in Low Power Mode, and no event could say which
sessions were in it). Split `Board Render Failed` by it before reading a
`render_stalled` or `paint_timeout` rate as a fleet-wide number.

## `Board Render Failed` — when the board does not draw

Every other event on this page describes a render that worked. This one is the
opposite, and it was added because a render that fails is otherwise invisible:
the native rejection was a `console.warn` plus one Sentry event per failure kind
per JS lifetime, the expo-image load failures were the same, and no dashboard
had anything at all. A session where every render failed after the seventh swipe
(the Aura 12x12 blank-overlay report) looked exactly like a session that never
failed.

It fires from five places, all in
`packages/mobile/src/hooks/use-native-climb-render.ts`:

- the hold-match check, run just before the native call (see "The config stage"
  below) — the only failure here that never throws;
- the native render's `.catch`, for every rejection — including the capability
  fallbacks that Sentry is deliberately never told about (#4240);
- `reportOverlayLoadFailure`, the single writer behind every `onOverlayError`
  path, so a load failure cannot be handled without being counted;
- the paint watchdog, for an overlay expo-image never answered about;
- the render stall watchdog, for a play-board render the JS render scheduler or
  native itself has not answered in time (see "The render stall watchdog"
  below).

### Properties

Common props (the table above) plus:

| Property                | Values                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `surface`               | `play` \| `full` \| `thumbnail` \| `prefetch` — see below; `play` and `prefetch` are opt-in, not derived                                  |
| `stage`                 | `config` \| `native` \| `image_load` — which part of the path gave up                                                                       |
| `failure_kind`          | on `config`: `no_matching_holds` \| `partial_hold_match`. On `native`: `render_failed` \| `disk_full` \| `capability_fallback` \| `render_stalled`. On `image_load`: `cache_entry_missing` \| `retry_exhausted` \| `cache_entry_present` \| `validation_failed` \| `validation_unsupported` \| `paint_timeout` |
| `error_code`            | `code_<n>` \| `png` \| `cgimage` \| `write` \| `module` \| `capability` \| `no_matching_holds` \| `partial_hold_match` \| `paint_timeout` \| `render_stalled` \| `other` |
| `render_width`          | requested overlay width in pixels, or `null` for a native-width render                                                                     |
| `frames_length`         | length of the frames string — a cheap proxy for climb complexity                                                                          |
| `failures_this_session` | running count for this JS lifetime, INCLUDING this event                                                                                   |
| `lit_count`             | config stage only: how many placements frame 0 lights. A count, never the ids — the ids are the climb                                     |
| `unmatched_count`       | config stage only: how many of those the board config has no hold for                                                                     |
| `stall_state`           | `render_stalled` only, absent elsewhere: `queued` \| `dispatched` — where the render was waiting when the watchdog fired                    |
| `queue_depth`           | `render_stalled` only, absent elsewhere: renders waiting in the JS render scheduler, this one included when queued                          |
| `dispatched_count`      | `render_stalled` only, absent elsewhere: renders handed to native and not yet answered                                                     |
| `ms_waiting`            | `render_stalled` only, absent elsewhere: milliseconds since this surface asked for the render                                              |

`stage` and `failure_kind` are one discriminated pair in
`BoardRenderFailedInput`, not two free fields: a native rejection can never be
`retry_exhausted` and an image load can never be `disk_full`. Pairing them in the
type is what stops a call site inventing a combination no query would match.

#### `surface` is opt-in, and `play` means exactly one board

`play` is the play drawer's CURRENT card and nothing else — `SwipeBoardCarousel`
passes `playSurface` to it explicitly. Twelve other call sites render a board at
full size and none of them do: the board-look preview cards and rails,
`CustomLookPreview`, `BoardPreviewSheet`, `ClimbReactionMenu`, `WallHeroStage`,
and the carousel's own off-screen peek. They are all `full`.

Do not collapse the two. `full` covers surfaces that are off-screen, behind a
sheet, or one of a dozen preview cards drawn at once, so a failure rate pooled
across `play` and `full` would not describe anything a climber experienced.
`thumbnail` is still just the filled style the list and accessory rows ask for.

`prefetch` is the fourth, and it is opt-in the same way: `UpcomingBoardPrefetch`
warms the board renders for the next few climbs in the queue while the drawer is
open, at the render scheduler's idle-only `prefetch` rank. Nobody is looking at
those renders, so their failures belong in their own bucket — pooled into `full`
they would inflate a rate no climber experienced, and on their own they answer
the one question this rank raises: whether the warm-up fails while the visible
board is fine.

#### What this event still cannot see

The hold-match check compares placement IDS. Rust drops a hold for a second
reason it never reports: `parse_frames`
(`packages/board-renderer/core/src/frames_parser.rs:21`) looks each hold's ROLE
code up in `hold_state_map` and silently skips the hold when the code is absent.
A climb whose frames carry only unknown role codes therefore still produces a
veil-only PNG with no event of any kind. Extending the check to role codes is a
follow-up.

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

- `no_matching_holds` (nothing would draw): report, **evict** and **skip the
  render**. Rendering would cache a blank overlay under that key, making the same
  failure quieter on every later visit. The overlay stays null and the wall photo
  still shows — the existing missing-layer contract.
- `partial_hold_match` (some draw, some do not): report and **render anyway**.

The check runs ABOVE the overlay-cache lookup, and that ordering is the fix, not
a detail. Builds from before it cached veil-only PNGs under the **same**
`RENDERER_VERSION`, so the startup warm-up scan restores them from disk; with the
check below the lookup, that entry was handed straight back and everyone who had
already hit the bug would have kept a blank board forever on the fixed build too.
Checking first also makes cache re-insertion moot — a mismatched key is answered
before anything consults the index — and the stale entry is dropped from the
index AND cleared off screen, since the state seed reads the index during the
first render, before this effect runs. Bumping `RENDERER_VERSION` would have
worked too and was rejected: it flushes every user's overlay cache.
A climb that legitimately reaches past a smaller layout loses the holds off the
edge and keeps the rest, which is degraded, not blank.

### The paint watchdog

The remaining iOS suspect is a correctly rendered file that expo-image never
paints: the same climbs draw fine on Android and on the host, so the PNG is not
the problem. expo-image is supposed to answer with `onLoad` or `onError`;
silence is a third outcome nothing was watching for.

So the play board — `surface: 'play'` only — starts a 4s timer, cancelled by
`onOverlayLoad` for that exact load key, by `onOverlayError`, by the load key
changing, or by unmount. If it fires, `failure_kind: 'paint_timeout'`.

It arms off the view layer's MOUNT signal (`onOverlayMounted` in
`LayeredClimbImage`), never off `overlayUri`, and that distinction is the whole
correctness argument. `LayeredClimbImage` renders a bare `<View>` and no image at
all while the app is backgrounded or the tab's board art is released — and
opening `/play` releases it for every other tab surface
(`board-art-visibility-provider.tsx`). Nothing there can fire `onLoad`, because
there is no `<Image>` to fire it, so a watchdog armed on the URI would report
guaranteed-bogus silence, and a backgrounded app's JS timers would land on resume
before the remount ever got the chance to answer.

**Observation only.** The overlay is not nulled and nothing is retried. A file
that renders correctly but never paints is a different fault from one that
failed to load, and handling it as the latter — null the overlay, spend the
once-per-key retry budget — is exactly what would hide it again.

### The render stall watchdog

Added for issue #5187: a phone in Low Power Mode could sit for seconds with no
holds drawn, and nothing measured the stage before the paint watchdog above —
the render request itself, waiting to be answered. Every `renderHoldsOverlay`
call used to run on expo-modules-core's one shared serial queue, so the play
board's render could queue behind every off-screen thumbnail a fast scroll had
already started, and a throttled CPU stretched that wait past what anyone
noticed.

Renders now go through a JS scheduler (`packages/mobile/src/lib/board-render/render-scheduler.ts`)
before they reach native. So the play board — `surface: 'play'` only — arms a
6s timer when it asks for a render. 6s is well past what even a throttled
device needs for a single overlay, so a fire means something is actually
stuck, not just slow. If the timer fires, the event carries `stall_state`:

- `'queued'` — the request is still sitting in our own JS queue. The fix is on
  our side: shorten the queue (fewer surfaces requesting renders at once,
  cheaper priorities) or raise the dispatch window.
- `'dispatched'` — native already has the request and has not answered. The
  fix is native: the `[native-train]` follow-up moves the board renderer onto
  its own concurrent queue (and reports `renderConcurrency`, which widens the
  scheduler's dispatch window on those binaries).

**Observation only, play-board only**, like the paint watchdog: the render is
never abandoned or retried, and a thumbnail or preview card would arm one of
these per row for no reason. It lives under `stage: 'native'` because that is
the stage being waited on, even when `stall_state` says the wait is still in
our own queue.

A stall is late, not failed, so it has its own budget of 10 events per JS
lifetime and does NOT advance `failures_this_session` (it reports the running
count as it stands). A throttled phone can be late on every swipe of a long
session; sharing the 25-event budget would let one slow evening silence the
genuine failures that follow, and sharing the counter would make a slow
session read as a broken one. Two more guards: `ms_waiting` counts from when
the request was FIRST asked for (a joined request inherits the first asker's
clock), and a timer that lands more than 10 s past its schedule is dropped,
because iOS suspends JS with the app and a watchdog armed just before
backgrounding would otherwise report the whole background stretch as a stall.

### Three session caps, not one

The hook counts every failure in a module-scoped counter and stops firing after
25 per JS lifetime — with the config stage on its own separate budget of 10,
and `render_stalled` on a third budget of 10 (see the stall watchdog above).

The split is load-bearing. A config mismatch is a property of a climb-and-board
pair, so a board whose sets do not cover a climb's holds produces one on every
row of a list. Sharing a budget would let a single scroll spend the whole
session's telemetry on one unchanging answer and silence the native and
image_load signals, which are the ones that move. Config events are also deduped
by surface + cache key across every hook instance (a bounded 200-key set, so a
recycled FlashList row cannot re-report a climb it already answered for). The
surface is part of the claim because the queue prefetch warms the SAME key the
play board asks for next; a claim shared between them would report the mismatch
as `prefetch` and leave the play view a climber actually saw silent.

On the 25 for the other stages: The failure this event exists for is a device that fails
EVERY render from some point on, and `getOrStartInflightRender` drops the settled
promise, so every recycled FlashList row tries again — the storm shape from
#3647. 25 events is plenty to see which stage, kind and code a session is stuck
on. Past the cap nothing is sent but `failures_this_session` keeps counting, so
a stream that stops at 25 reads as truncated rather than as a device that failed
exactly 25 times.

One `onError` is exactly one `Board Render Failed`. The image_load stage names
what became of the image — `retry_exhausted` once the one retry is spent, the
entry kind before that — and never both. PostHog is counting images that failed,
so firing the entry kind and `retry_exhausted` together made two real errors read
as three failures and spent the budget a third early. Sentry still hears both
classes, because there it is diagnosing failure classes rather than counting.

Sentry keeps its own, tighter budget — one report per failure kind per lifetime —
and now carries `failuresThisSession` in `extra` plus a `board-render` breadcrumb
for every failure, so the single report it does send can say whether it was a
one-off or the first of hundreds.

### Reading it

**Read this as an absolute count, not a rate.** `Climb View Opened` was the
denominator every per-view rate on this page used, and it is gone — there is no
"renders attempted" event to divide by, and inventing one would cost more volume
than the failures do. Count the failures themselves, stratified by
`board_name` × `render_mode`, and compare a window against the same window on
an earlier release rather than against a denominator.

That makes install-base drift the thing to watch: a count that doubles after a
release could be twice the failures or twice the climbers. Anchor a comparison
on a stable per-user event (`$feature_flag_called` is off, so use something like
active users over the same window) before calling a rise a regression.

Stratify the same way as everything else on this page: never pool across
`board_name`, and never pool `render_mode`. Two useful reads:

- `Board Render Failed` counts split by `board_name` × `render_mode` — the
  Aura-vs-classic question the original report raised;
- `stage` × `failure_kind` × `error_code` for one board, which is what separates
  "this climb does not belong to this board" from "the renderer is rejecting"
  from "the PNG will not load back" from "iOS never painted it".
- `Board Render Failed` broken down by `failure_kind` and `stall_state` — the
  queued-vs-dispatched split that says whether a stall run is a queue problem
  or a native problem.

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
are — www renders boards again (see "www and the share cards" below) but has no
board-look picker to instrument, so a future web surface would reuse these
names and property shape rather than minting a second funnel.

## www and the share cards

Board rendering is not mobile-only any more. www's card and feed thumbnails, the
kiosk and embed slots, and the `GET /og/climb` share cards all draw Aura too, and
they build their config through the same `buildRenderConfig` +
`@boardsesh/board-look` path the app does.

None of it is instrumented, and that is deliberate rather than an omission:
these events measure **the look a climber chose and the renders that failed on
their phone**, and www has neither. There is no look picker on www (every
surface renders the shipped default) and no per-climber render settings. So
`render_mode` on an event still means "what the app drew", and the populations
these numbers describe are still app climbers.

If a www surface ever grows a look picker or a render failure worth counting, it
reuses these names and this property shape; do not mint a second funnel.

## Stratification: never pool

**Always split by `board_name`.** Boards differ enough in art, hold density
and photo busyness that a glow-falloff or render-mode effect on one board can
point the opposite direction on another — Grasshopper's busy photo and a bare
MoonBoard grid are not comparable renders, and pooling them into one number
erases whichever direction is the minority board.

**Always split by `glow_falloff_source`.** Only `mode = aura` climbers
have a `glow_falloff` at all, and among those, `glow_falloff_source: 'user'`
(a climber who picked a falloff in Settings) is a self-selected population —
they are not a random sample of `aura` climbers, and pooling them with
`'default'` biases the comparison toward whatever the opinionated minority
prefers. Read the shipped falloff on `glow_falloff_source = 'default'` alone.

There is no `'flag'` value any more. It was the third source while
`board-glow-falloff` was live, and that flag is retired — the type is
`'user' | 'default'`, and a query filtered on `'flag'` returns nothing.

## PostHog setup

Nothing has ever been created in PostHog for issue #2202 — no saved insight, no
cohort, no experiment reads any of these events. That is what made the three
climb-view events safe to delete. If a dashboard is ever built:

1. **No feature flags.** Both board-render flags (`board-render-mode-default`,
   `board-glow-falloff`) were retired for 2.4: the Aura drawing is the app
   default and its glow curve is a climber-facing setting, so there is no
   rollout or experiment left to configure, and nothing here carries
   `$feature_flag` / `$feature_flag_response`.

2. **Read `render_mode` and `glow_falloff` observationally, not as arms.** They
   are still on every event and still worth splitting by — but the populations
   are self-selected now (a climber on `classic` in 2.4 actively chose it), so
   treat any difference as a correlation, not a measured effect.

3. **What is left to measure, one set per board** (see the stratification rule
   above):
   - `Board Render Failed` counts, split by `stage` × `failure_kind` ×
     `error_code`. An absolute count — the per-view denominator is gone; see
     "Reading it" above.
   - The board-look funnel: `Board Look Step Resolved` outcomes as a share of
     `Board Look Step Shown`, split by `selected_option` and `cards_viewed`.
     This pair is self-denominating, so it is the one true rate on this page.
   - `Board Render Settings Changed` and `Board Render Preset Applied` counts,
     split by `field` / `preset_id` — which knobs climbers actually touch after
     the step.
4. **How fast climbers commit to a climb is no longer measured.** That was
   `Climb First Action`'s `ms_since_open`, and answering it again means minting
   a new event and paying its volume — not resurrecting a retired one. The same
   goes for "did the climber have to zoom in to read the wall", which was
   `Board Pinch`.
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
