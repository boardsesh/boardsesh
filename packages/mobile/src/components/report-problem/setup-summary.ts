// A board setup in words, for the "Set up wrong" fields, the done step and the
// review sheet's suggestions: "Original · 12×12 · Bolt Ons + Screw Ons". Pure,
// so a table test pins it without a sheet.
//
// Names come from the static board catalogue through the board builder's own
// labels (`cleanLayoutName`, `formatSizeLabel`), so a setup reads here exactly
// as it does on the builder's chips. Hold set names are the catalogue's, which
// the builder shows untranslated too.

import {
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  parseSetIds,
  toBoardName,
} from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { cleanLayoutName, formatSizeLabel } from '../board-discovery/board-builder-labels';

/** A setup as a selection or a `BoardSetup` carries it. */
export type SetupForLabels = {
  layoutId: number | null;
  sizeId: number | null;
  /** Ids, or the comma-separated string the API carries. */
  setIds: readonly number[] | string;
  /** Part of the setup only on a board that doesn't tilt; null or absent leaves it out. */
  angle?: number | null;
};

/** Each part of a setup in words; null for a part the catalogue doesn't know or the setup doesn't pick. */
export type SetupLabels = {
  layout: string | null;
  size: string | null;
  /** The picked hold sets in catalogue order, joined with " + ". */
  holds: string | null;
  angle: string | null;
};

/** "40°". */
export function formatAngleLabel(angle: number): string {
  return `${angle}°`;
}

export function setupLabels(boardName: BoardName, setup: SetupForLabels): SetupLabels {
  const { layoutId, sizeId } = setup;
  const layout = layoutId != null ? getBoardLayouts(boardName).find((candidate) => candidate.id === layoutId) : null;
  const size =
    layoutId != null && sizeId != null
      ? getBoardSizesForLayoutId(boardName, layoutId).find((candidate) => candidate.id === sizeId)
      : null;
  const picked = new Set(typeof setup.setIds === 'string' ? parseSetIds(setup.setIds) : setup.setIds);
  const holds =
    layoutId != null && sizeId != null
      ? getBoardSetsForLayoutAndSize(boardName, layoutId, sizeId)
          .filter((set) => picked.has(set.id))
          .map((set) => set.name)
      : [];
  return {
    layout: layout ? cleanLayoutName(layout.name, boardName) : null,
    size: size ? formatSizeLabel(size) : null,
    holds: holds.length > 0 ? holds.join(' + ') : null,
    angle: setup.angle != null ? formatAngleLabel(setup.angle) : null,
  };
}

/**
 * The whole setup on one line, its known parts joined with " · ". Null for a
 * board type this build doesn't know, or a setup none of whose parts it knows.
 */
export function formatSetupSummary(boardType: string, setup: SetupForLabels): string | null {
  const boardName = toBoardName(boardType);
  if (!boardName) return null;
  const labels = setupLabels(boardName, setup);
  const parts = [labels.layout, labels.size, labels.holds, labels.angle].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * A board's own setup on one line. Its angle is part of the setup only when the
 * board doesn't tilt; on one that does, the angle is whatever the wall is at.
 */
export function formatBoardSetupSummary(board: {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  isAngleAdjustable: boolean;
}): string | null {
  return formatSetupSummary(board.boardType, { ...board, angle: board.isAngleAdjustable ? null : board.angle });
}
