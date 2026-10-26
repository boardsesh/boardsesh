# Climb view options

What a climber can change about the player (the climb view): the sections below the climb, and the player buttons
around Log (#6229). Both live in the player's ⋯ → **View options** sheet, on two tabs, **Below the climb** and
**Buttons**. Settings → Climbs & grades → **Climb view** has the same switches on the native form; the order only
changes in View options (#6477, #6480). The sections half is described in
[mobile-sheets-vs-routes.md › Play drawer section controls](mobile-sheets-vs-routes.md#play-drawer-section-controls);
this page covers the buttons and what both share.

## What the climber gets

- **Buttons**: a switch and ↑/↓ arrows for Mirror, Favorite, Angle, Share and Queue; one switch for **Previous and
  next**; and a **Position**, Below the board (the default) or Above the board. A pinned preview draws the bar for
  the board on screen as the climber changes it.
- **Restore defaults** on the Buttons tab brings back today's bar, below the board, with Previous and next. The
  Below the climb tab has its own Restore defaults for the sections.
- Nothing changes until the climber changes it.

Fixed, and why:

| Control                                  | Why it doesn't move                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Log                                      | The core loop. Always the centre of the big row.                            |
| Board light                              | Wall control must not move under a climber's thumb. Always the right slot.  |
| Put on the wall, busy-wall question, connect pill, Fell / Sent | Session states, not preferences. They show up in the small row when they need it. |
| Playback slider                          | Belongs to the board, so it always sits next to it.                         |
| Top row ⌄ · list · rest timer · ⋯        | ⋯ is how a hidden button comes back. Where you are (the list, "Projects · 4 of 23", or the workout stage, "4x4 · Rep 3 of 4 · Set 2 of 4") sits between ⌄ and the timer and costs the board nothing. A second, smaller line there is for what the wall is doing. |

## Layout rules

`resolveActionBarLayout` (`packages/mobile/src/components/play-drawer/action-bar-layout.ts`) is the one rule. The
bar, the player's ⋯ menu and the preview all read it, so they can't disagree.

```
Big row     [lead] [⏮] [Log] [⏭] [Board light]
Small row   [first half of the rest] ········ [last half]
```

- **Lead slot**: the first of Mirror and Queue, in the climber's order, that is on and can show here. Mirror shows
  only on a board that mirrors (`boardSupportsMirroring`); Queue only for a member. With both off the slot is
  empty and the row keeps its five-slot spacing.
- **Small row**: every other button that is on, in order. The last ⌊n/2⌋ form the right-hand group; the odd one out
  goes left. Mirror counts only on a board that mirrors, Favorite and Queue only for a member. Angle and Share
  count even where this board or climb can't draw them (a fixed-angle board, a draft): they leave their place
  empty instead, so nothing jumps sides between climbs and today's bars come out exactly as they were.
- **Previous and next off** leaves both slots empty, so Log stays centred. Swiping the board still moves.
- **The connect pill** replaces the right-hand group. **Put on the wall** (`commitButton: 'putOnWall'`) sits in the
  gap in the middle of the small row. The first button of the start group and the last of the end group keep their
  places; the rest step into ⋯ while it shows, because the label needs ~140 pt and a mirror board's full row leaves
  ~120 pt on a 375 pt phone. Only the busy-wall question (`commitButton: 'confirm'`, "Keep Sam's" / "Put mine up")
  replaces the whole row. Whatever the pill, the button and the question push out, and every button the climber
  switched off, is flagged in `hidden`, and ⋯ carries a row for each.
- **Fell / Sent** (`workoutOutcome: true`, `secondaryRow: 'workoutOutcome'`) takes the whole small row while the climb
  on the wall is in a timed workout block: its stage paces the rest timer (a 4x4, limit bouldering, on the minute).
  See [One-tap Fell / Sent](#one-tap-fell--sent). The order of the session states is busy-wall question > Put on the
  wall > Fell / Sent > connect pill > the climber's buttons. The lead slot keeps its button, the bulb stays in its
  slot (the pill gives way), and every small-row button steps into ⋯ while the pair shows.
- **Nothing left to draw**, no pill and no commit button: there is no small row (`secondaryRow: []`). The board gets
  52 pt back (the 8 pt gap and the 44 pt row; the 12 pt bottom padding moves to the big row). Put on the wall, the
  busy-wall question, Fell / Sent and the connect pill bring the row back while they need it, so a row with every
  button switched off still appears with Put on the wall alone in it. Share switched on keeps the row even on a draft, where it
  can't draw (`['spacer']`, held at the row's usual 64 pt): it is the one button that comes and goes climb to
  climb, and the board must not jump mid-swipe. The angle depends on the board, not the climb, so an angle-only
  row on a fixed-angle board does collapse.
- **The anonymous web reader** gets today's bar under the board whatever the device stored: they have no ⋯ to bring
  a hidden button back, and no View options to undo a choice left in a shared browser.

Today's bars, which the defaults reproduce (pinned in `resolve-action-bar-layout.test.ts`):

```
Kilter, MoonBoard     [☰]  [⏮]  [✓]  [⏭]  [💡]   /  [♡] [40°] ············ [⬆]
Tension, Decoy, Woods [⇄]  [⏮]  [✓]  [⏭]  [💡]   /  [♡] [40°] ········ [⬆] [☰]
Anonymous             [ ]  [⏮]  [✓]  [⏭]  [ ]    /  [40°] ················ [⬆]   (mirror boards keep [⇄])
```

### ⋯ stand-ins

`PlayDrawerHiddenButtons` has a flag per button: `favorite`, `share`, `queue`, `mirror`, `angle`. The player's ⋯
offers a row only while its flag is up (`play-drawer-menu-rows.ts`), so an action never shows twice. Mirror and
Change angle form their own group after the queue rows. Both are disabled on another board's climb, like every row
that writes or touches the wall. The Mirror row runs the same `handleMirror` as the button (shared-session
orientation included); Change angle opens the player's own angle sheet, so it presents above `/play`.

### One-tap Fell / Sent

In a timed workout block (#6231, #5380) every go gets logged, so the small row becomes two 44 pt buttons. Both save
through `useTickSaver`, the same path as the Log ascent sheet, so the rest timer and the workout's tick log get the
tick's status and queue item exactly as from the sheet (`docs/workout-stages.md` › Pacing).

- **Fell** logs one try at once (`attempt`, 1 try). Nothing waits for the end of the climb, so an early End, a killed
  app or a dead signal loses no falls.
- **Sent** logs a flash when the climber has no tick on the climb at this angle and no fall on this queue item
  earlier in the block, else a send (`deriveAscentType`). While the logbook is still loading it says send, as the
  sheet does.
- **A spray climb nobody has sent** needs a grade, which only the sheet asks for, so Sent opens Log ascent instead.
  Fell still logs at once: a try sets no grade. The queue's copy of the climb never hears of a send, so once the
  climber's own send is in this block's tick log (this queue item) or their logbook (this angle), later Sents log in
  one tap again.
- **One tap at a time.** A second tap within 700 ms (`ONE_TAP_GUARD_MS`), on either button, is dropped, and so is a
  tap while a save is still in flight. A fumbled double tap logs one go, never a fall and a send.
- **A 4x4 set is one climb, every rep.** Each Fell or Sent is one rep on the climb on the wall, and the climb stays up
  (with the row) until the set's last rep is logged, then the set rest runs and the wall moves on. A Sent after the
  set's first rep logs a send, never a flash: the first rep is already in the block's tick log for this queue item.
- **Just after the wall moves on.** An on-the-minute beat advances whether the climber logged or not, so a tap within
  2 s (`WALL_MOVED_GRACE_MS`) of the climb on the wall changing logs for the climb it left, against that queue item
  (`TickSaveFields.queueItem`), with that climb's own flash rule. Every one-tap names its queue item this way, and
  the saver still holds it to `attributeTickToQueueItem`'s angle rule: a tap at another angle than the item is up at
  (the board moved, the queue has not regraded yet) saves the tick but counts it for no queue item. Nobody gets a go on a climb that fast after it
  lights up. A first ascent there can't open the sheet (it would open on the new climb), so the row says to swipe
  back to it. A new copy of the same queue item is not a move.
- **The row stays through the grace when the wall leaves the block** (`useWorkoutOutcomeHold`). When the beat moves
  the wall onto a climb outside the timed block, the gate turns false at once, and the normal row would put the heart
  and the angle button where Fell was, under a finger already on its way (simulator QA: a Fell tap just after the
  last beat opened Choose Angle). So the player keeps Fell / Sent for the climb it left for the same 2 s, then swaps.
  Taps in that window log there, exactly as above; one past it is dropped, never sent to the new climb. The hints
  name that climb ("Logs one try on Crimp line, the previous climb") and the saved line is the full sentence, since
  the board already shows the next one. The hold starts only when the committed climb changed with the player still
  on it; a swipe to browse, the gate coming back, the switch-board gate or a sign-out ends it at once. PlayCore reads
  the held row for the bar layout, ⋯, the connect pill and the opening layout key, so the row and the board change
  once, at the swap.
- **The wall at the tap.** The row leaves `useTickSaver`'s `active` out, so each save takes the board as it is right
  then: a board bound from the bulb mid-block is on the next tick. The sheet snapshots it when it opens instead.
- **When it shows** (`shouldShowWorkoutOutcome`): the climb on screen is the committed current one (not a climb the
  climber swiped to or a preview), its run stage has `pacing` (keyed on the pacing, not the stage kinds, so any
  future timed block gets it too), the climber is signed in, it is not another board's climb and not a draft. A
  crew phone without the run never shows it. While it shows, the connect pill can't, so the pill's day budget is not
  spent (`deriveFirstConnectPillWouldConnect`'s `workoutOutcome`).
- **The row says what a tap did, not a toast.** The player is a native modal on iOS, and the root toast overlay draws
  behind it (a toast fired from the player is never seen there). So after a save the tapped button reads "Try logged"
  (Fell) or "Flash logged" / "Send logged" (Sent) with a check for 2 s (`SAVED_NOTICE_MS`), and both buttons stay
  live. When the go was for the climb the wall just left, the line names it ("Flash logged · Crimp line"). The
  buttons keep their Fell / Sent accessibility labels; the full sentence is announced. A failure, or where to log a
  first ascent, needs reading, so it takes the whole row for 5 s (`MESSAGE_NOTICE_MS`) or until tapped, then the
  buttons come back. The success haptic plays with the line; a failure's comes from `useTickSaver`. Tick Logged and
  Quick Tick Failed report `surface: 'mobile_workout_runner'`, with no Quick Tick Opened before them.
- **A save outlives the row.** Swiping to a preview, the end of the hold after the wall left the timed block or
  closing the player unmounts the row while a save can still be in flight. `useTickSaver` runs the side effects (rest timer, the workout's tick
  log, Tick Logged, the confirmation) off the `mutateAsync` promise, which settles either way, never off a per-call
  `mutate` callback, which React Query drops once the caller is gone. With no row left to say it, that late save
  falls back to the toast, which shows once the player is closed.
- The pair holds the row's usual 64 pt, so the board moves only for a climber who switched every small button off.
  The opening-layout cache keys on it (`controlsFingerprint`).

### Above the board

`PlayCore` renders the controls region (playback slider, bar, and the switch-board scrim over both) either after
the board or between the header and the lost-holds banner. The block moves whole, so the scrim and its card still
cover every control. Above the board the bar comes first and the slider follows, so the slider stays next to the
board, and the bar's hairline moves to its bottom edge (`edge="bottom"`), the side that faces the board.

The switch-board card (another board's climb) is taller than the controls, more so with the small row off. A card
that spilled out of the region would sit under the next sibling (the board above the fold, the first section below
it), and that view would take the taps meant for Switch board. So while the card is up the region's `minHeight` is
the card's measured height plus 8 pt above and below (a typical 184 pt card until the first measurement), in both
positions. Above the board the region also has `zIndex: 1` over the lost-holds banner and the board. The region
is measured while it sits above, and the wall-state callout hangs below it instead of below the header, so the
notice never covers Log. The opening-layout cache keys on the resolved small row and the position, since both move
the board. The tablet-shell and phone-split panes render the same `PlayCore`, so all of this applies there too.

## Storage

All device-local, in the synchronous settings store (MMKV), so the player's first frame already has the climber's
bar: no jump from today's bar to theirs.

| Key                     | Type                          | Default   | Notes                                                                                         |
| ----------------------- | ----------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `playerButtonsV1`       | `SectionLayoutRecord \| null` | `null`    | Order and switches. Read and written only by `playerButtonsStore` (`createSectionLayoutStore`). |
| `playerPreviousNext`    | `boolean`                     | `true`    | Only an explicit `false` hides the pair.                                                      |
| `playerButtonsPosition` | `'below' \| 'above'`          | `'below'` | Anything else reads as `'below'`.                                                             |

- `null` means the defaults, so a later release's default order still reaches a climber who never changed it. The
  store writes `null` again when a change lands back on the defaults, and on Restore defaults.
- Ids this build doesn't know survive its writes, after the id they followed (`createSectionLayoutStore`), so a
  newer bundle's buttons survive an OTA rollback and one edit.
- **Rollback**: an older bundle ignores all three keys and draws today's bar below the board. Nothing is lost; the
  choices come back with the newer bundle.
- `resetAllSettings` clears all three.

The sections below the climb keep their own AsyncStorage record (`playDrawerSections`); see
[mobile-sheets-vs-routes.md](mobile-sheets-vs-routes.md#play-drawer-section-controls).

## Code map

| Piece                                   | File                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| Ids, defaults, position type            | `packages/mobile/src/lib/player-buttons.ts`                                     |
| Store, hooks, Restore defaults          | `packages/mobile/src/lib/player-buttons-preference.ts`                          |
| Layout rule                             | `packages/mobile/src/components/play-drawer/action-bar-layout.ts`               |
| Bar                                     | `packages/mobile/src/components/play-drawer/PlayDrawerActionBar.tsx`            |
| Fell / Sent row and its taps            | `packages/mobile/src/components/play-drawer/WorkoutOutcomeRow.tsx`, `use-workout-one-tap.ts` |
| Fell / Sent hold after the wall leaves  | `packages/mobile/src/components/play-drawer/use-workout-outcome-hold.ts`        |
| Placement, callout offset, ⋯ wiring     | `packages/mobile/src/components/play-drawer/PlayCore.tsx`                       |
| View options sheet (both tabs)          | `packages/mobile/src/components/play-drawer/PlayDrawerSectionsSheet.tsx`        |
| Shared labels and actions               | `packages/mobile/src/components/settings/use-player-button-controls.ts`         |
| Preview                                 | `packages/mobile/src/components/player-buttons/PlayerButtonsPreview.tsx`        |
| Settings › Climb view                   | `packages/mobile/src/components/settings/climb-view/`, `app/settings/climb-view.tsx` |
| Reorder rows (shared with sections)     | `packages/mobile/src/components/section-layout/SectionLayoutList.tsx`           |

## Adding a button

1. Add the id to `PLAYER_BUTTON_IDS` in `player-buttons.ts`, at the place its default should be. A stored order
   without it slots it in after the id it follows in the defaults.
2. Decide in `resolveActionBarLayout` whether it takes a place for this board and viewer, and whether it can draw
   right now. Add a flag to `PlayDrawerHiddenButtons`, a ⋯ row in `use-climb-actions.ts` and `MENU_GROUPS`, and a
   case in the bar and the preview.
3. Add its label (and a subtitle if it only shows on some boards) to `use-player-button-controls.ts`, in every
   locale.
4. Extend the layout table in `resolve-action-bar-layout.test.ts`, starting with "today's bars unchanged".

## Adding a section

Every section sits below the fold and takes part in the order: add its id to `BELOW_FOLD_SECTION_IDS` in
`play-drawer-sections-preference.ts`, a default visibility, a label, and a `case` in `DeferredSections`. See
[mobile-sheets-vs-routes.md](mobile-sheets-vs-routes.md#play-drawer-section-controls) for the record and the fold.
