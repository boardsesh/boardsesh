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
| Put on the wall, busy-wall question, connect pill | Session states, not preferences. They show up in the small row when they need it. |
| Playback slider                          | Belongs to the board, so it always sits next to it.                         |
| Top row ⌄ · list · rest timer · ⋯        | ⋯ is how a hidden button comes back. The list you're playing from ("Projects · 4 of 23") sits between ⌄ and the timer and costs the board nothing. |

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
- **Nothing left to draw**, no pill and no commit button: there is no small row (`secondaryRow: []`). The board gets
  52 pt back (the 8 pt gap and the 44 pt row; the 12 pt bottom padding moves to the big row). Put on the wall, the
  busy-wall question and the connect pill bring the row back while they need it, so a row with every button
  switched off still appears with Put on the wall alone in it. Share switched on keeps the row even on a draft, where it
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
the board. The iPad pane renders the same `PlayCore`, so all of this applies there too.

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
