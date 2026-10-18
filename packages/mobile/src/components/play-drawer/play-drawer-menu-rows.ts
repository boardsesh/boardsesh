import type { AppMenuAction } from '../AppMenu.types';
import type { ClimbActionId, ClimbActionItem } from '../climb-actions/use-climb-actions';
import { iconMap } from '../icon-map';

/** One row of the player's ⋯ menu: what the menu draws, plus what a tap on it runs. */
export type PlayDrawerMenuRow = AppMenuAction & { id: ClimbActionId; run: () => void };

/**
 * Action-bar buttons this viewer is entitled to but the bar is not showing right
 * now (switched off in View options, commit mode, the connect pill). ⋯ carries a
 * row for each one that is true, so the action never disappears with its
 * button. Resolved by `resolveActionBarLayout`.
 */
export type PlayDrawerHiddenButtons = {
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
};

/**
 * The menu's fixed order, one array per group. A divider opens every group after
 * the first that has a row. Ids not listed here are never offered from the
 * player:
 *
 * - `preview`: the climber is already looking at the climb.
 * - `tick`: the hero button in the bar is always there for a member.
 * - `editEntry`: a logbook-only row.
 */
const MENU_GROUPS: readonly (readonly ClimbActionId[])[] = [
  ['playNext', 'queue', 'openQueue'],
  ['mirror', 'angle'],
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
const LIVE_ON_BOARD_MISMATCH: ReadonlySet<ClimbActionId> = new Set<ClimbActionId>([
  'share',
  'viewOptions',
  'openInApp',
]);

function isOffered(id: ClimbActionId, { hidden, isActiveClimb }: PlayDrawerMenuRowOptions): boolean {
  switch (id) {
    case 'playNext':
      return !isActiveClimb;
    // These are bar buttons first. The menu only stands in while the bar has
    // put the button away, so the same action never shows up twice.
    case 'openQueue':
      return hidden.queue;
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
  items: readonly ClimbActionItem[],
  options: PlayDrawerMenuRowOptions,
): PlayDrawerMenuRow[] {
  const itemsById = new Map<ClimbActionId, ClimbActionItem>(items.map((item) => [item.id, item]));
  const rows: PlayDrawerMenuRow[] = [];

  for (const group of MENU_GROUPS) {
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
