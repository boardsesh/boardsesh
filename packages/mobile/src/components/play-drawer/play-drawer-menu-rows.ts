import type { AppMenuAction } from '../AppMenu.types';
import type { ClimbActionId } from '../climb-actions/use-climb-actions';
import { iconMap, type IconName } from '../icon-map';

/**
 * Every row the player's ⋯ can carry: the shared climb actions, plus the
 * player's own Board controls (the board sheet, #7000).
 */
export type PlayDrawerMenuRowId = ClimbActionId | 'boardControls';

/** What a row is built from. A `ClimbActionItem` is one. */
export type PlayDrawerMenuItem = { id: PlayDrawerMenuRowId; title: string; icon: IconName; run: () => void };

/** One row of the player's ⋯ menu: what the menu draws, plus what a tap on it runs. */
export type PlayDrawerMenuRow = AppMenuAction & { id: PlayDrawerMenuRowId; run: () => void };

/**
 * Action-bar buttons this viewer is entitled to but the bar is not showing right
 * now (switched off in View options, commit mode, the connect pill). ⋯ carries a
 * row for each one that is true, so the action never disappears with its
 * button. Resolved by `resolveActionBarLayout`.
 */
export type PlayDrawerHiddenButtons = {
  /** Log: only in a timed block with the wall button in the top row, where Fell / Sent log each go. */
  tick: boolean;
  favorite: boolean;
  share: boolean;
  queue: boolean;
  mirror: boolean;
  angle: boolean;
};

export type PlayDrawerMenuRowOptions = {
  hidden: PlayDrawerHiddenButtons;
  /** The switch-board scrim is up: the climb belongs to a board the climber isn't on. */
  boardMismatch: boolean;
  /** The displayed climb is the one on the wall, so "Play next" means nothing. */
  isActiveClimb: boolean;
  /**
   * The menu's order, one array per group, for a surface that orders its rows
   * differently (the MiniPlayer's ⋯). Defaults to the player's.
   */
  groups?: ClimbMenuGroups;
};

/** A menu's order: one array per group, a divider before every group after the first that has a row. */
export type ClimbMenuGroups = readonly (readonly PlayDrawerMenuRowId[])[];

/**
 * The menu's fixed order, one array per group. A divider opens every group after
 * the first that has a row. Ids not listed here are never offered from the
 * player:
 *
 * - `preview`: the climber is already looking at the climb.
 * - `editEntry`: a logbook-only row.
 *
 * `tick` is offered only while the bar puts Log away (a timed block in wall
 * button mode, #7000).
 */
const MENU_GROUPS: ClimbMenuGroups = [
  ['tick', 'playNext', 'queue', 'openQueue'],
  ['mirror', 'angle', 'boardControls'],
  ['playlist', 'favorite', 'share'],
  ['betaVideo', 'edit', 'fork'],
  ['viewOptions', 'openInApp'],
  ['report', 'delete'],
];

/**
 * Rows that neither write nor touch the wall, so they stay live while the climb
 * belongs to another board. Every other row is shown disabled there rather than
 * hidden: a disabled row says what is unavailable, and keeping it in its slot
 * keeps the menu the same shape as the bar's scrim comes and goes.
 */
const LIVE_ON_BOARD_MISMATCH: ReadonlySet<PlayDrawerMenuRowId> = new Set<PlayDrawerMenuRowId>([
  'share',
  'viewOptions',
  'openInApp',
  // The board sheet acts on the connected board, not on this climb.
  'boardControls',
]);

function isOffered(id: PlayDrawerMenuRowId, { hidden, isActiveClimb }: PlayDrawerMenuRowOptions): boolean {
  switch (id) {
    case 'playNext':
      return !isActiveClimb;
    // These are bar buttons first. The menu only stands in while the bar has
    // put the button away, so the same action never shows up twice.
    case 'openQueue':
      return hidden.queue;
    case 'tick':
      return hidden.tick;
    case 'favorite':
      return hidden.favorite;
    case 'share':
      return hidden.share;
    case 'mirror':
      return hidden.mirror;
    case 'angle':
      return hidden.angle;
    default:
      return true;
  }
}

/**
 * The rows the player's ⋯ menu shows for one climb and one bar state.
 *
 * Pure so the row set can be tested per state: which rows exist, in which
 * order, which are disabled, and where the dividers fall. The caller maps a
 * tapped index back through the array THIS call returned, never a later one.
 */
export function buildPlayDrawerMenuRows(
  items: readonly PlayDrawerMenuItem[],
  options: PlayDrawerMenuRowOptions,
): PlayDrawerMenuRow[] {
  const itemsById = new Map<PlayDrawerMenuRowId, PlayDrawerMenuItem>(items.map((item) => [item.id, item]));
  const rows: PlayDrawerMenuRow[] = [];

  for (const group of options.groups ?? MENU_GROUPS) {
    let opensGroup = rows.length > 0;
    for (const id of group) {
      const item = itemsById.get(id);
      if (!item || !isOffered(id, options)) continue;
      rows.push({
        id,
        run: item.run,
        label: item.title,
        systemIcon: iconMap[item.icon].ios,
        destructive: id === 'delete',
        disabled: options.boardMismatch && !LIVE_ON_BOARD_MISMATCH.has(id),
        dividerBefore: opensGroup,
      });
      opensGroup = false;
    }
  }

  return rows;
}

/**
 * The displayed slot ⋯ → Play next should move, or `undefined` to let it match
 * by climb. Only a slot that is really in the queue qualifies: a preview's item
 * is not queued, and `planPlayNext` inserts a duplicate for a slot it can't find
 * instead of moving the copy that is queued.
 */
export function resolveQueuedSlotUuid(
  queue: readonly { uuid: string }[],
  displayedQueueItemUuid: string | undefined,
): string | undefined {
  if (displayedQueueItemUuid === undefined) return undefined;
  return queue.some((queueItem) => queueItem.uuid === displayedQueueItemUuid) ? displayedQueueItemUuid : undefined;
}
