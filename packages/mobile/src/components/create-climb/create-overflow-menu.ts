import type { AppMenuAction } from '../AppMenu.types';

/** What the climber picked. The header maps a tapped index back to one of these. */
export type CreateOverflowAction = 'makeRoute' | 'makeBoulder' | 'deleteFrame' | 'newClimb';

export type CreateOverflowRow = AppMenuAction & { action: CreateOverflowAction };

export type CreateOverflowMenuState = {
  /** False on a board whose climbs can only ever hold one frame (Woods). */
  supportsMultiFrame: boolean;
  /** Whether the setter has switched this climb into route mode. */
  routeMode: boolean;
  frameCount: number;
  /** The frame the transport is sitting on, zero-based. */
  frameIndex: number;
};

/** Translate hook shaped like `react-i18next`'s `t`, so the builder stays pure. */
type Translate = (key: string, params?: Record<string, number | string>) => string;

/**
 * The rows the creator's overflow (⋯) menu shows, for one editor state.
 *
 * Pure and total so the row set can be unit-tested per state — the menu is the
 * only way to reach route mode, so "which rows exist when" is behaviour, not
 * presentation.
 *
 * Two rules the row order encodes:
 *
 * - **Woods gets no route rows at all.** Its packet builder rejects the comma a
 *   second frame introduces, so offering the mode would be offering a climb that
 *   cannot be sent to the wall.
 * - **Leaving route mode is blocked, not hidden, above one frame.** Frames are
 *   absolute snapshots: "keep frame 1" would discard every hold painted after the
 *   start position, and flattening would silently rewrite the climb. Neither is
 *   an honest answer to a menu tap, so the row stays visible, disabled, and says
 *   what to do instead — a hidden row would just read as a missing feature.
 */
export function buildCreateOverflowMenu(state: CreateOverflowMenuState, t: Translate): CreateOverflowRow[] {
  const rows: CreateOverflowRow[] = [];

  if (state.supportsMultiFrame) {
    if (!state.routeMode && state.frameCount === 1) {
      rows.push({
        action: 'makeRoute',
        label: t('mobile.create.routeMenu.makeRoute'),
        systemIcon: 'film.stack',
      });
    } else {
      if (state.frameCount > 1) {
        rows.push({
          action: 'deleteFrame',
          // Named by ordinal: "Delete frame" beside a strip of four makes you
          // guess which one it means, and the answer (the one you are on) is not
          // visible in the menu.
          label: t('mobile.create.routeMenu.deleteFrame', { index: state.frameIndex + 1 }),
          systemIcon: 'trash',
          destructive: true,
        });
      }
      const canLeave = state.frameCount === 1;
      rows.push({
        action: 'makeBoulder',
        label: canLeave ? t('mobile.create.routeMenu.makeBoulder') : t('mobile.create.routeMenu.makeBoulderBlocked'),
        systemIcon: 'square.stack',
        disabled: !canLeave,
      });
    }
  }

  rows.push({
    action: 'newClimb',
    // Moved out of the action bar, where a `+` that discards the whole climb sat
    // a thumb's width from the `+` that adds a frame to it.
    label: t('mobile.create.actions.newClimb'),
    systemIcon: 'plus',
    destructive: true,
  });

  return rows;
}
