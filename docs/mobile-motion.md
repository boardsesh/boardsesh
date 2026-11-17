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
- **Critically damped, stiffness from the release.** k = max(400, (v / d)²), damping = 2√(k·m),
  where v is the release speed toward the target and d the distance left. At that stiffness the
  spring starts at exactly the finger's speed and cannot pass its target. A speed pointing away
  from the target is dropped.
- **Timing.** A flick reaches 90% of the remaining distance in 40–75 ms (the iPhone 17 Pro
  recording's releases: 71, 65 and 42 ms). A slow release or a standstill takes about 190 ms. A
  swipe let go short comes back the same way, without the 8% overshoot `interactive` gave it.
- **Landing.** It finishes within a quarter point of its target (`PAGING_LANDED_DISTANCE`), at
  5–10 pt/s, rather than at Reanimated's default energy floor, which kept a flick creeping on below
  a pixel until about 300 ms.
- **Reduce Motion.** Reanimated skips the spring and the step lands at once.

A board that must travel further than the swipe settles (the PNG board leaving a letterboxed
frame) stretches its own path toward the ends of the swipe instead of extending the spring;
see `pageOffset` in `use-swipe-pager.ts`.

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
the same way in both climbs never change. Dragging dims the holds only the old climb uses
from 100% to 40% by the pager's commit distance (80 points), and holds them there; a
cancelled drag follows the pager's spring back. A commit runs one 200 ms swap on its own
clock: old-only holds fade out over 0–120 ms with ease-in, new-only holds fade in over
60–200 ms with ease-out, and the new holds wait until the old ones are down to 40%.
Catching the board mid-swap and pulling it back eases from what is on screen; a second
commit ends the first swap at once. Reduce Motion: no drag dim, and the swap is one
120 ms dissolve. The PNG fallback still slides the whole board.

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
