# Mobile motion, haptics and Queue Undo

Spring and timing presets, variant-aware motion, the haptics rules and the queue Undo contract. They moved here from [ai-design-guidelines.md](./ai-design-guidelines.md), which keeps the one-screen summary.

## Motion & haptics

**Springs** (`theme/animations.ts`, for reanimated `withSpring`):

| Preset        | damping / stiffness / mass | Use                                                   |
| ------------- | -------------------------- | ----------------------------------------------------- |
| `snappy`      | 20 / 300 / 0.7             | UI controls (toggles, switches, tabs, press feedback) |
| `interactive` | 20 / 250 / 1.0             | Dragging, swiping, pressing                           |
| `gentle`      | 15 / 150 / 1.0             | Sheet presentations, layout changes                   |
| `bouncy`      | 10 / 200 / 0.7             | Playful overshoot (success, celebrations)             |
| `paging`      | 40 / 400 / 1.0 (floor)     | A page settling after a swipe; see [Paging](#paging)  |

**Timing** (`withTiming`): `instant` 50ms · `fast` 150ms · `normal` 250ms · `slow` 350ms.

### Paging

The player's swipe between climbs settles with `pagingSpring(from, to, velocity)`
(`theme/paging-spring.ts`), never a fixed preset. `springs.paging` is its floor.

- **Where it lands.** At the content's real resting place: one board width along for a step, 0 for
  a swipe let go short. Never at a padded target the content is clamped short of: content that hits
  a clamp at speed stops dead in one frame.
- **Critically damped, stiffness from the release.** k = max(2025, (v / d)²), damping = 2√(k·m),
  where v is the release speed toward the target and d the distance left. At that stiffness the
  spring starts from the finger's speed and cannot pass its target. A speed pointing away from the
  target is dropped.
- **Timing.** Measured by stepping Reanimated 4.7's own `withSpring` at 120 Hz
  (`theme/__tests__/paging-spring.test.ts`), on a 335 pt board:

  | Release | 90% of the way | JS told (old spring) | Lands (old spring) |
  | --- | --- | --- | --- |
  | 244 pt at 2,950 pt/s | 67 ms | 33 ms (33) | 150 ms (117) |
  | 263 pt at 2,550 pt/s | 67 ms | 25 ms (33) | 142 ms (125) |
  | 292 pt at 2,350 pt/s | 50 ms | 8 ms (25) | 92 ms (117) |
  | 233 pt at 2,900 pt/s | 75 ms | 42 ms (42) | 158 ms (125) |
  | 170 pt, still | 92 ms | 67 ms (92) | 192 ms (192) |
  | 85 pt at 300 pt/s | 92 ms | 83 ms (108) | 200 ms (183) |
  | 200 pt at 500 pt/s | 92 ms | 58 ms (83) | 183 ms (183) |

  The first four are the iPhone 17 Pro recording's releases. The old spring "landed" on an
  invisible tail after the content had already stopped dead at the board's width. The floor is set
  by the slow rows: at 400 a still release took about 450 ms to land, and the drawer's pull-down
  and the next swipe waited on that. A swipe let go short comes back the same way, within 200 ms,
  without the 8% overshoot `interactive` gave it.
- **Landing.** It finishes within half a point of its target (`PAGING_LANDED_DISTANCE`): the last
  frame moves about 0.5 pt where the one before moved about 0.2. Reanimated's default energy floor
  keeps it creeping on below a pixel for 100 ms or more.
- **Telling the JS thread.** The pager tells it once the incoming board is within 10% of the
  middle (`TELL_JS_REMAINING`), never later than the old spring did. The anchored GPU board does
  not care when: its native scene picks the same pages and progress either side of that change.
- **Reduce Motion.** Reanimated skips the spring and the step lands at once.

A board that must travel further than the swipe settles (the PNG board leaving a letterboxed
frame) stretches its own path toward the ends of the swipe instead of extending the spring, by
at most 48 pt (`PAGE_MAX_STRETCH`). A wider margin, on an iPad or a phone on its side, would leave
a large empty gap between the boards; there the boards fade out of, and in from, the margin over
the outer 30% of the swipe instead. See `pageOffset` in `use-swipe-pager.ts`.

**Variant-aware motion** (`theme.motion`, resolved from `motionByVariant`): for `withTiming`
transitions that should follow the active design language. `theme.motion.standard` (utility:
fades, small moves) and `theme.motion.emphasized` (hero: sheet/FAB moves, larger layout shifts)
are pure-data `MotionConfig`s — Material carries an M3 easing curve + M3 duration (200 / 350ms),
Liquid Glass carries the prior `timing` durations with no easing override. Build the reanimated
config at the call site with `timingFor` (it stays out of the token modules so they remain
reanimated-free for `makeThemeMock`): `value.value = withTiming(target, timingFor(theme.motion.emphasized))`.
Springs (press/gesture feedback) stay variant-agnostic — these tokens cover the shared `withTiming` moves.

**Player wall swap** (`play-drawer/wall-swap.ts`, GPU boards on native API 6). Swiping
between climbs keeps the wall still and hands the lit holds over in two steps. Holds lit
the same way in both climbs dip with the rest and never go dark: they follow the brighter
of the old-only and new-only holds, never below 40% (native API 7; API 6 keeps them fully
lit). Dragging dims the holds only the old climb uses
from 100% to 40% by the pager's commit distance (80 points), and holds them there; a
cancelled drag follows the pager's spring back. A commit runs one 200 ms swap on its own
clock: old-only holds fade out over 0–120 ms with ease-in, new-only holds fade in over
60–200 ms with ease-out, and the new holds wait until the old ones are down to 40%.
Catching the board mid-swap lets the swap run on; pulling it back toward the old climb
(4 points past where it was caught) eases from what is on screen over 120 ms. A second
commit onward ends the first swap at once and swaps from the climb it skips at 40% (or at
its weight on screen if that is higher), so a skipped climb never flashes whole; the next
climb is at rest 200 ms after the second commit. Limit: the climb the first swap was
leaving goes dark in that one frame, by its weight then (40% or less after a drag to the
commit distance, up to about 80% after a short flick). The native view only has the
climbs either side of the pager's centre prepared, and the centre moves on 40–110 ms after
the commit, so the older pair cannot stay on screen. A commit straight back to the old climb starts
from what is on screen, the same pair named the other way round, so nothing jumps; if the
first swap was still easing a pulled-back board to whole, that ease carries on and the
climb the climber turned back from never lights. A commit toward the other side of a pulled-back board
first eases that board's climb back to whole over 120 ms, then swaps. Reduce Motion: no
drag dim, and the swap is one 120 ms dissolve that leaves shared holds fully lit. The PNG
fallback still slides the whole board.

**Haptics** (`packages/mobile/src/lib/haptics.ts`, expo-haptics, no-ops where unsupported). Visual
press feedback is separate (that's `PressableSurface`); fire haptics from the handler:

- `hapticSelection()` — selection changes (pickers, segmented controls)
- `hapticLight()` — minor interactions (toggle, button press)
- `hapticMedium()` — standard interactions (swipe action)
- `hapticHeavy()` — significant interactions (drag-drop, destructive)
- `hapticSuccess()` / `hapticError()` / `hapticWarning()` — notification feedback (climb logged, etc.)

### Haptics

Apple's "Playing haptics" guidance: use them sparingly, and only for something the climber
just did. The rules:

1. **Only the local climber's own action buzzes.** A teammate's send, a screen mounting, a
   playback reaching its end, or a sheet presenting do not.
2. **A plain button gets no haptic.** The press state is the feedback. Prev, next, share and
   sign-in stay silent.
3. **A toggle gets `hapticSelection()`.** Mirror, favourite, segmented controls, and a sheet
   dragged from one detent to another (`useDetentDragHaptic`).
4. **An outcome gets a notification haptic, once, from its toast.** `showToast(…, 'success')`
   and `showToast(…, 'error')` play `hapticSuccess()` / `hapticError()` themselves. A caller
   that toasts must not also call a notification haptic, or the climber feels it twice. An
   outcome with no toast (an inline error, a sheet closing on save) keeps its own haptic.

### Queue Undo

Clear (from Edit or from ⋯ → Clear queue), the bulk Remove bar and a row's Remove all offer Undo
inside the queue sheet, where a native modal cannot hide it.
The provider serializes the removals and composes Undo from the live queue when those requests
finish, preserving crew additions, removals and order during a retry. The shared GraphQL transport
owns bounded attempts and rate-limit retries; do not race a second deadline against that promise.
Undo restores the current climb only if this removal cleared it, keeps live items within the
500-climb sync limit, and expires when the session, board configuration or account changes.
VoiceOver announcements queue behind current speech; Android uses its live region.

The Undo lasts 8 s. With VoiceOver or TalkBack running it lasts 80 s, ten times as long. The
10× is the ratio WCAG 2.2.1 (Timing Adjustable) uses for extending a time limit; borrowing it
is not 2.2.1 conformance on its own, because a climber without a screen reader still gets 8 s
and cannot change it. A screen-reader user has to reach the snackbar, hear it and double-tap,
which takes far longer than a glance. On Android the 80 s grows to the climber's "Time to take
action" setting (Android 10+) when that is longer, the same rule Material's own Snackbar
follows; `useRecommendedTimeout` asks again each time TalkBack turns on, since Android sends no
event when the setting changes. It still ends: the iPad side panel never closes, and an
hour-old offer would restore a queue the crew has moved past. Switching the screen reader on or
off while the Undo is up re-arms the timer with the new length (Paper only reads `duration`
when it mounts, so `UndoSnackbar` keys it on the duration).

Each time the Undo appears with a screen reader running, focus moves onto the Undo button half
a second later. Every one of these removals unmounts the control the climber was on: the ⋯
and Edit go once the queue is empty, the Remove bar goes with the selection, and the row goes
with the climb. The half second is for ⋯ → Clear queue: when the native menu closes, iOS can
hand VoiceOver focus back to its anchor and override an earlier move, and both snackbar
entrances start transparent (a 220 ms fade on glass, 200 ms on Paper), which VoiceOver skips.
On iOS the queued announcement waits for the focus move, so VoiceOver reads the Undo button
first and the message after it. Other `UndoSnackbar` callers (logbook delete, wall change)
keep their durations and do not move focus; `focusUndoOnShow` is opt-in.

Focus is not handed back when the Undo goes away. After a tap on Undo, or when the 80 s runs
out, the pill unmounts while it may hold focus. Issue #7243 tracks returning focus to the
restored ⋯ or row.

The browser app keeps 8 s and leaves focus alone, because react-native-web's
`isScreenReaderEnabled` always resolves true and cannot tell who is running one.
