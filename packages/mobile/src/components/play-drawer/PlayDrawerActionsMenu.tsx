import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { AppMenu } from '../AppMenu';
import { useClimbActions, type ClimbActionsFavoriteControl } from '../climb-actions/use-climb-actions';
import type { DismissSurfaceAndWait } from '../create-climb/use-create-climb-navigation';
import { useActiveClimbUuid } from '../../providers/queue-provider';
import { useProfile } from '../../lib/graphql/hooks';
import { buildPlayDrawerMenuRows, type PlayDrawerHiddenButtons } from './play-drawer-menu-rows';
import type { BoardConfig } from './play-drawer-types';

/** Opens one of the player's own sheets, pinned to the climb ⋯ was opened on. */
type PinnedSheetOpener = (climb: Climb, boardConfig: BoardConfig) => void;

export type PlayDrawerActionsMenuProps = {
  climb: Climb;
  /**
   * The board the climb is DRAWN on (PlayCore's `renderBoardConfig`), never the
   * selected board. A climb from another board is queued, shared and reported
   * against its own board.
   */
  boardConfig: BoardConfig;
  /**
   * The queue slot on screen, when that slot is in the queue. With the same
   * climb queued twice, Play next moves THIS copy; without it the move falls
   * back to the first copy after the current climb. Leave it out for a preview
   * that isn't queued: `planPlayNext` inserts a fresh copy for an unknown slot.
   */
  queueItemUuid?: string;
  isAuthenticated: boolean;
  /** Bar buttons ⋯ stands in for right now (`resolveActionBarLayout`). */
  hidden: PlayDrawerHiddenButtons;
  /** The switch-board scrim is up: every row that writes is disabled. */
  boardMismatch: boolean;
  /** The bar heart's state, optimistic override included. */
  isFavorited: boolean;
  // Every row that opens a sheet takes the player's OWN opener. A root opener
  // (`useDrawerHost().openLogAscent` and friends) presents its sheet under the
  // `/play` modal, where it flashes open and vanishes (#3505, #3294 for the
  // playlist). `useClimbActions` falls back to the root opener when one is left
  // out, so these are required: leaving one off is a type error. Typing can't
  // tell a player opener from a root one, though; the cross-board suite opens
  // each sheet through the player and is the real guard on that.
  /** The bar heart's toggle, so the heart and the row can never disagree. */
  onToggleFavorite: () => void;
  onTick: PinnedSheetOpener;
  onAddBetaVideo: PinnedSheetOpener;
  onReportClimb: PinnedSheetOpener;
  onSelectPlaylist: PinnedSheetOpener;
  onOpenQueue: () => void;
  onOpenViewOptions: () => void;
  /** Supplied only by the `/play` route; the persistent iPad pane has nothing to dismiss. */
  dismissPlayerAndWait?: DismissSurfaceAndWait;
};

/**
 * The player's ⋯, top right: a native menu (a SwiftUI `Menu` on iOS, a Compose
 * dropdown on Android, a Paper menu on web) over the shared climb actions.
 *
 * A menu row reports a position, so a row set that changes while the menu is
 * open (a crew member moves the wall, commit mode flips, the scrim comes up)
 * would land a tap on whatever row has moved into that slot. The menu is keyed
 * on the climb and its row set instead: any such change remounts it, which closes
 * it, and a tap always resolves against the rows it was drawn from.
 */
export const PlayDrawerActionsMenu = memo(function PlayDrawerActionsMenu({
  climb,
  boardConfig,
  queueItemUuid,
  isAuthenticated,
  hidden,
  boardMismatch,
  isFavorited,
  onToggleFavorite,
  onTick,
  onAddBetaVideo,
  onReportClimb,
  onSelectPlaylist,
  onOpenQueue,
  onOpenViewOptions,
  dismissPlayerAndWait,
}: PlayDrawerActionsMenuProps) {
  const { t } = useTranslation('session');
  const activeClimbUuid = useActiveClimbUuid();
  // Who is looking decides Edit, Delete and Report. Read off the app-wide profile
  // cache, the same answer the long-press menu gets, rather than the player's
  // per-climb snapshot: that one is empty until it lands and again on every
  // angle change, which would show a setter Report in place of Edit for a beat
  // and remount the menu twice when a crew member moves the wall.
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const currentUserId = isAuthenticated ? (profile?.id ?? null) : null;

  const favoriteControl = useMemo<ClimbActionsFavoriteControl>(
    () => ({ isFavorited, onToggle: onToggleFavorite }),
    [isFavorited, onToggleFavorite],
  );
  const handleSelectPlaylist = useCallback(
    () => onSelectPlaylist(climb, boardConfig),
    [onSelectPlaylist, climb, boardConfig],
  );

  const items = useClimbActions({
    climb,
    boardConfig,
    queueItemUuid,
    currentUserId,
    isAuthenticated,
    onSelectPlaylist: handleSelectPlaylist,
    onTick,
    onAddBetaVideo,
    onReportClimb,
    onOpenQueue,
    onOpenViewOptions,
    dismissPlayerAndWait,
    favoriteControl,
    analyticsSource: 'play_drawer_menu',
  });

  const isActiveClimb = climb.uuid === activeClimbUuid;
  const rows = useMemo(
    () => buildPlayDrawerMenuRows(items, { hidden, boardMismatch, isActiveClimb }),
    [items, hidden, boardMismatch, isActiveClimb],
  );
  // Disabled rows are refused here as well as by the platform menus: the row set
  // is data, and the next row added to it may not guard itself.
  const handleSelectIndex = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row || row.disabled) return;
      row.run();
    },
    [rows],
  );
  const rowSignature = rows.map((row) => (row.disabled ? `${row.id}:off` : row.id)).join(',');

  return (
    <AppMenu
      key={`${climb.uuid}|${rowSignature}`}
      iconName="more"
      accessibilityLabel={t('playView.actionBar.climbActionsAria')}
      actions={rows}
      onSelectIndex={handleSelectIndex}
    />
  );
});
