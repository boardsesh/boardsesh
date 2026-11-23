// Maps saved boards (UserBoard, and the In range rows that carry one) onto the
// single DiscoveryBoardItem the picker's cards and rows render. Keeps the
// screen free of per-shape branching.

import type { UserBoard } from '@boardsesh/shared-schema';
import {
  boardRowSubtitle,
  disambiguateBoardSubtitles,
  normaliseSetIds,
  toBoardName,
  type BoardLabelOptions,
} from '@boardsesh/board-config';
import type { DiscoveryBoardItem } from './BoardDiscoveryCard';
import { boardIsOwnedBy } from './manage-items';
import type { BoardDownloadState } from './board-offline-state';

export function userBoardToItem(
  board: UserBoard,
  activeUuid?: string | null,
  /**
   * Whether this board's catalog is on the device. Only owned/followed boards
   * get one (see settings/offline-boards.ts).
   */
  offlineState?: BoardDownloadState,
  /**
   * The signed-in user's id, when the host has one. Resolving ownership here —
   * once per list build — is what keeps the card's action slot off a
   * `myBoards.find` inside a virtualized row. Omitted (and therefore
   * `isViewerOwner: undefined`) on Near you, where every board belongs to
   * someone else, and wherever no identity resolved: an undefined flag means
   * "we don't know", which the card renders as no action slot at all rather
   * than offering to unfollow the user's own wall.
   */
  currentUserId?: string,
  /**
   * Whether this board is pinned, when the caller has an optimistic override for
   * it. Defaults to the server's `isPinnedByMe`; the picker passes an override
   * so a just-tapped pin flips instantly without waiting for a refetch.
   */
  isPinnedOverride?: boolean,
  /**
   * Label options for the subtitle. The one thing a caller passes here is the
   * translated word for a spray wall, which this module cannot resolve — it is
   * pure, and the catalogue lives behind a React hook. Omitted everywhere a wall
   * cannot appear, and the subtitle then reads exactly as it did before.
   */
  labelOptions?: BoardLabelOptions,
): DiscoveryBoardItem | null {
  const boardName = toBoardName(board.boardType);
  if (boardName === null) return null;
  return {
    key: board.uuid,
    boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    title: board.name,
    subtitle: boardRowSubtitle(board, labelOptions),
    distanceMeters: board.distanceMeters ?? undefined,
    isActive: activeUuid != null && board.uuid === activeUuid,
    isViewerOwner: currentUserId === undefined ? undefined : boardIsOwnedBy(board, currentUserId),
    canEdit: board.canEdit,
    canDelete: board.canDelete,
    canRemoveFromGym: board.canRemoveFromGym,
    openReportCount: board.openReportCount,
    viewerHasOpenReport: board.viewerHasOpenReport,
    gymName: board.gymName,
    isPinned: isPinnedOverride ?? board.isPinnedByMe ?? false,
    offlineState: board.sprayImport ? undefined : offlineState,
    sprayImport: board.sprayImport,
  };
}

/**
 * Everything the list builder may be told, named.
 *
 * Named rather than positional because the callers are asymmetric: the "Your
 * boards" carousel passes all five, while Near you and the offline rows pass one
 * or two. Positionally that read as `(rows, uuid, undefined, undefined,
 * undefined, labelOptions)` — six arguments and three holes, where miscounting is
 * silent and the compiler cannot help (every optional slot is a different type
 * only by luck).
 */
export type UserBoardItemsOptions = {
  /** The active board's uuid, for the `isActive` flag. */
  activeUuid?: string | null;
  offlineStateFor?: (board: UserBoard) => BoardDownloadState;
  /** See `userBoardToItem` — resolves `isViewerOwner` once per list build. */
  currentUserId?: string;
  /** Uuids the user just toggled, pending the next fetch. See `userBoardToItem`. */
  pinnedOverrides?: ReadonlyMap<string, boolean>;
  /** See `userBoardToItem`. */
  labelOptions?: BoardLabelOptions;
  importStatusStale?: boolean;
};

/**
 * The whole carousel's items in one pass, with same-subtitle boards pulled apart
 * (see `disambiguateBoardSubtitles`). Disambiguation is scoped to the one list
 * the user is looking at, and runs here — at the list level — never per row.
 */
export function userBoardsToItems(boards: UserBoard[], options: UserBoardItemsOptions = {}): DiscoveryBoardItem[] {
  const { activeUuid, offlineStateFor, currentUserId, pinnedOverrides, labelOptions, importStatusStale } = options;
  // Only boards that actually render take part: a board dropped for an
  // unsupported type must not push its neighbour into a disambiguation the user
  // can see no reason for.
  const rendered: { item: DiscoveryBoardItem; board: UserBoard }[] = [];
  for (const board of boards) {
    const item = userBoardToItem(
      board,
      activeUuid,
      offlineStateFor?.(board),
      currentUserId,
      pinnedOverrides?.get(board.uuid),
      labelOptions,
    );
    if (item !== null) rendered.push({ item: { ...item, importStatusStale }, board });
  }
  const subtitles = disambiguateBoardSubtitles(
    rendered.map((entry) => entry.board),
    labelOptions,
  );
  return rendered.map((entry, index) => ({ ...entry.item, subtitle: subtitles[index] }));
}

/**
 * `userBoardsToItems` for rows that carry their own key (the In range rows,
 * keyed by serial or config because a hidden board found by serial has no
 * uuid, #6552). Each item keeps its row's key; a row the card cannot draw is
 * left out.
 */
export function boardRowsToItems(
  rows: readonly { key: string; board: UserBoard }[],
  options: UserBoardItemsOptions = {},
): DiscoveryBoardItem[] {
  const drawable = rows.filter((row) => toBoardName(row.board.boardType) !== null);
  const items = userBoardsToItems(
    drawable.map((row) => row.board),
    options,
  );
  return items.map((item, index) => ({ ...item, key: drawable[index]?.key ?? item.key }));
}

/**
 * The top of the picker's boards (At {gym}'s rows, the hero) as card items.
 * Each keeps the top's key, the name the top shows and the top's own say on
 * which is the board you're on. Subtitles are pulled apart across the whole
 * list as `userBoardsToItems` does; At {gym} passes the `within-gym` scope, so
 * they lead with what each wall is rather than the gym its title names.
 */
export function pickerTopBoardsToItems(
  boards: readonly { key: string; board: UserBoard; title: string; selected: boolean }[],
  {
    climbersBoardKeys,
    ...options
  }: Omit<UserBoardItemsOptions, 'activeUuid'> & {
    /**
     * The keys of the climber's own and followed boards. The rest of a gym's
     * roster is someone else's: no ownership, pin or download state, so its
     * accessibility label never says "Following" and its row draws no menu.
     */
    climbersBoardKeys?: ReadonlySet<string>;
  } = {},
): DiscoveryBoardItem[] {
  const topBoardsByKey = new Map(boards.map((topBoard) => [topBoard.key, topBoard]));
  return boardRowsToItems(boards, options).flatMap((item) => {
    const topBoard = topBoardsByKey.get(item.key);
    if (!topBoard) return [];
    const placed = { ...item, title: topBoard.title, isActive: topBoard.selected };
    if (climbersBoardKeys === undefined || climbersBoardKeys.has(item.key)) return [placed];
    return [
      {
        ...placed,
        isViewerOwner: undefined,
        isPinned: false,
        offlineState: undefined,
        canEdit: undefined,
        canDelete: undefined,
        canRemoveFromGym: undefined,
        openReportCount: undefined,
        viewerHasOpenReport: undefined,
      },
    ];
  });
}

/** A board config (the create/popular tuple), used to find an owned match. */
export type BoardConfigKey = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids, as stored on UserBoard. */
  setIds: string;
};

/**
 * The board the user already owns that exactly matches `config`, if any. Used to
 * activate an existing board instead of hitting the server's duplicate-config
 * guard when a popular/custom config the user already has is selected.
 */
export function findOwnedBoardForConfig(boards: UserBoard[], config: BoardConfigKey): UserBoard | undefined {
  // Compare set ids order/format-insensitively: '24,25,26,27' and '25,26,27,24'
  // are the same physical board. Re-ticking a set in the builder re-appends it
  // at the end of the array, so the wire order can diverge from the stored
  // order even for the user's own board. Without normalising, the match misses,
  // CREATE_BOARD fires, and the server inserts a near-duplicate UserBoard.
  const configSetIds = normaliseSetIds(config.setIds);
  return boards.find(
    (b) =>
      b.boardType === config.boardType &&
      b.layoutId === config.layoutId &&
      b.sizeId === config.sizeId &&
      normaliseSetIds(b.setIds) === configSetIds,
  );
}
