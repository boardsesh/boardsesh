// A board's menu rows as the ⋯, the hold and the screen-reader actions draw
// them, for a Near you card and a picker row alike: the same rows in the same
// order (`boardCardMenuEntries`), the same labels, and one way to run a row.

import { useCallback, useMemo } from 'react';
import type { AppMenuAction } from '../AppMenu.types';
import {
  BOARD_CARD_MENU_SYSTEM_ICONS,
  boardCardMenuEntries,
  boardCardMenuLabel,
  type BoardCardMenuEntry,
  type BoardCardMenuVia,
} from './board-card-menu';
import type { BoardCardMenu, DiscoveryBoardItem } from './BoardDiscoveryCardView';

export type BoardCardMenuRow = BoardCardMenuEntry & { label: string };

const NO_ROWS: readonly BoardCardMenuRow[] = [];

export type BoardCardMenuRows = {
  rows: readonly BoardCardMenuRow[];
  /** The rows as `AppMenu` draws them. */
  menuActions: AppMenuAction[];
  /** Runs the row at `index`, saying how the climber reached it. */
  runMenuRow: (index: number, via: BoardCardMenuVia) => void;
  selectFromMenuButton: (index: number) => void;
  selectFromHold: (index: number) => void;
};

/**
 * Scalars from the item, so a fresh item object with the same state keeps the
 * same rows, and with them the same menu and accessibility actions.
 */
export function useBoardCardMenuRows(item: DiscoveryBoardItem, menu: BoardCardMenu | undefined): BoardCardMenuRows {
  const isPinned = item.isPinned === true;
  const isImport = item.sprayImport != null;
  const isSprayWall = item.boardName === 'spray';
  const { offlineState, isViewerOwner, canEdit, canDelete, canRemoveFromGym, gymName } = item;
  const openReportCount = item.openReportCount ?? null;
  const viewerHasOpenReport = item.viewerHasOpenReport ?? null;
  const capabilities = menu?.capabilities;
  const labels = menu?.labels;
  const onMenuAction = menu?.onAction;
  const rows = useMemo<readonly BoardCardMenuRow[]>(() => {
    if (capabilities === undefined || labels === undefined) return NO_ROWS;
    const entries = boardCardMenuEntries(
      {
        isPinned,
        offlineState,
        isViewerOwner,
        isImport,
        canEdit,
        canDelete,
        canRemoveFromGym,
        gymName,
        openReportCount,
        viewerHasOpenReport,
      },
      capabilities,
    );
    if (entries.length === 0) return NO_ROWS;
    return entries.map((entry) => ({
      ...entry,
      label: boardCardMenuLabel(entry.action, labels, isSprayWall, gymName),
    }));
  }, [
    capabilities,
    labels,
    isPinned,
    offlineState,
    isViewerOwner,
    isImport,
    isSprayWall,
    canEdit,
    canDelete,
    canRemoveFromGym,
    gymName,
    openReportCount,
    viewerHasOpenReport,
  ]);
  const menuActions = useMemo<AppMenuAction[]>(
    () =>
      rows.map((row) => ({
        label: row.label,
        systemIcon: BOARD_CARD_MENU_SYSTEM_ICONS[row.action],
        destructive: row.destructive,
        dividerBefore: row.dividerBefore,
        disabled: row.disabled,
      })),
    [rows],
  );
  const runMenuRow = useCallback(
    (index: number, via: BoardCardMenuVia) => {
      const row = rows[index];
      if (row !== undefined && !row.disabled) onMenuAction?.(item, row.action, via);
    },
    [rows, onMenuAction, item],
  );
  const selectFromMenuButton = useCallback((index: number) => runMenuRow(index, 'menu_button'), [runMenuRow]);
  const selectFromHold = useCallback((index: number) => runMenuRow(index, 'long_press'), [runMenuRow]);
  return { rows, menuActions, runMenuRow, selectFromMenuButton, selectFromHold };
}
