Fixes #3914

> **Device-QA gate — stays a draft until it passes.** This is an accessibility change whose real behaviour lives in VoiceOver and TalkBack, not in CI. See [QA Notes](#qa-notes) for the exact checks.

## What and why

Queue rows and climb-list rows are tappable, but their press does not live on an RN `Pressable` — it lives on a `react-native-gesture-handler` `Gesture.Tap()`. A VoiceOver or TalkBack user could focus the row, hear "Crimp Master, position 1, button", double-tap, and nothing happened. Same for the queue's tick button and the climb row's ⋮ button. Every one of those affordances was a dead end for a screen-reader user.

## Verified root cause

RNGH's `Gesture` API builds native gesture recognizers that never register with React Native's accessibility-action bridge. Checked against `react-native-gesture-handler@2.32.0`: neither the `Gesture` builders nor RNGH's own `Touchable` / `GenericTouchable` / `BaseButton` set `onAccessibilityTap` or `accessibilityActions`. RN core's `Pressable` is exempt because it rides the standard touch-responder chain, which the OS activates for free. Anything wrapped in a `GestureDetector` has to wire the accessibility channel itself.

There is a second layer, found in review. Both row containers are marked `accessible`. UIKit treats an accessibility element as a leaf, so VoiceOver never traverses into it — wiring `onAccessibilityTap` on the _nested_ tick/⋮ views can never fire on iOS, because focus never lands there. TalkBack does still focus inside the container (RN Android does not set `no-hide-descendants` automatically), so the nested props are load-bearing on Android only.

## The fix

`packages/mobile/src/components/QueueItemRow.tsx` and `ClimbListRow.tsx`, with the platform-gated action lists shared from `packages/mobile/src/lib/row-accessibility-actions.ts`:

- Row containers get `onAccessibilityTap` plus an `onAccessibilityAction` handler that branches on `actionName`, both routed to the exact handlers the RNGH taps already call. No press handler was touched — only new callers were added.
- The secondary affordance is published as a **labelled custom action on the row itself**, which is the element VoiceOver actually focuses: `logAscent` (label `mobile.queue.logAscent`) on a history queue row, `moreActions` (label `mobile.climbRow.moreActions`) on a climb row that shows the ⋮ button. Both keys already exist in `en-US`, `es` and `fr`, so no catalog churn.
- The nested tick / ⋮ views keep their own `onAccessibilityTap` + action, which is the working route on Android.
- The bare `activate` entry is **Android-only**. On Android `'activate'` maps to `ACTION_CLICK` in `ReactAccessibilityDelegate` and is the only route, since `onAccessibilityTap` is not implemented there. On iOS it is redundant (`accessibilityActivate` already routes the double-tap to `onAccessibilityTap`) _and_ harmful: every `accessibilityActions` entry becomes a `UIAccessibilityCustomAction` announced by its raw `name` when it carries no label, so VoiceOver would read out a developer-facing "activate" on every row of every list.
- No double-fire on either platform: iOS Fabric's `accessibilityActivate` calls `onAccessibilityTap` only; iOS Paper prefers the action and short-circuits; Android dispatches only the action event and returns `true` without calling `super`. Exactly once everywhere.
- The queue drag handle is deliberately left alone. Reordering with a screen reader needs worded move-up / move-down custom actions, which is product copy, not a guess. Same for the climb row's long-press-only actions path when `showMoreButton` is false. Both are commented in place as follow-ups.

Perf: the row action list is a `useMemo` keyed on the resolved **label string** rather than on `t` — `react-i18next` hands back a fresh `t` identity on plenty of renders, which would rebuild the array every time and churn the row element's props. The Android-only `activate` array is module-level and never rebuilt. `React.memo` prop equality on both rows is untouched.

## Tests

`packages/mobile/src/components/__tests__/queue-item-row-memo.test.tsx` (extended) and `climb-list-row-accessibility.test.tsx` (new) — 23 tests, all green. They capture the props the component actually renders and invoke them, rather than rebuilding a predicate.

Revert check (`git checkout origin/main -- QueueItemRow.tsx ClimbListRow.tsx`, tests untouched): **11 of the 12 new tests fail**, with real prop-read failures (`expected "undefined" to be "function"`, `expected undefined to be defined`). The twelfth is a negative guard ("offers no tick action on a row without a tick button") that carries a `toBeTypeOf('function')` precondition so it cannot pass vacuously — it fails on revert too via that precondition; the count above is from the run before that precondition was added.

What each covers:

| Test                                                                                       | Fails on revert because                                        |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| activates the row from a screen-reader tap and from the activate action (both files)       | `onAccessibilityTap` / `onAccessibilityAction` are `undefined` |
| toggles selection from a screen-reader activation while in edit mode                       | activation never reaches `onToggleSelect`                      |
| logs an ascent from a screen-reader activation of the tick button                          | nested tick props are `undefined`                              |
| publishes the tick / ⋮ as a labelled custom action on the row itself                       | row `accessibilityActions` is `undefined`                      |
| opens the actions menu from a screen-reader activation of the ⋮ button                     | nested ⋮ props are `undefined`                                 |
| leaves an unsupported row inert                                                            | preconditions assert the channel exists first                  |
| keeps one accessibilityActions array across rerenders                                      | array is `undefined`                                           |
| adds the activate action on Android (re-imports each module with `Platform.OS = 'android'`; one per component) | pins the platform gate in both directions |

Also asserted: a foreign action name (`magicTap`) is a no-op on every handler, and activating a nested button never also presses the row.

Validation: `vp run typecheck:mobile` pass, `vp check` pass (0 errors; the 289 warnings are pre-existing and none reference these four files), scoped `vp test run` 23/23.

<a name="qa-notes"></a>

## QA Notes

CI cannot verify this. It needs a real device pass on both platforms.

**iOS + VoiceOver**

1. Play drawer → queue list. Swipe to a queue row. Confirm it reads `"<climb>, position N, button"` and a **double-tap makes that climb current**.
2. Confirm VoiceOver does **not** announce a stray, untranslated "activate" custom action on any row. (This is the regression the Android gate exists to prevent.)
3. Queue history rows: with the row focused, rotor → Actions. Confirm a **"Log ascent"** action is offered and firing it opens the log-ascent flow — and that it does **not** also make the climb current or dismiss the sheet.
4. Climb list (search results): confirm double-tap opens the climb, and that a row with the ⋮ button offers a **"More actions"** custom action that opens the reaction menu.
5. Edit mode in the queue: confirm double-tap **toggles selection** instead of playing the climb.
6. Worth reporting either way: whether VoiceOver can focus the nested tick / ⋮ views at all. The prediction is no — that is exactly why the row-level custom actions exist. If it turns out it _can_, the nested wiring is a live second route and should be re-checked for double-announcement.

**Android + TalkBack**

1. Same row activation via double-tap on queue and climb rows.
2. Confirm the nested tick and ⋮ buttons **can** be focused and activated directly (this is the Android-only `activate`/`ACTION_CLICK` route).
3. Confirm the row's "Log ascent" / "More actions" custom actions also work from the row's action menu, and that neither route fires twice.

**Known gaps, out of scope here:** the queue drag handle has no reorder actions; a climb row with `showMoreButton` false still hides its long-press menu from screen readers; `LogbookRow.tsx` has the identical bare-`View`-inside-`GestureDetector` shape with no activation wiring. All three want their own product copy and are follow-ups.

## Release Notes

Queue rows and climb rows now respond to VoiceOver and TalkBack. Double-tap a row to play the climb or select it in edit mode, and reach "Log ascent" on a history row or "More actions" on a climb row straight from the row's actions — no more tapping into dead ends.
