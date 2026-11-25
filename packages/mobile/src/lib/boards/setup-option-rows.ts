// The rows of Set up's pushed Layout or Size checklist (`/boards/add/setup-option`),
// read from the catalogue. Pure, so it is a table in tests.

import {
  cleanLayoutName,
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  setupSizeLabel,
} from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import type { SetupOptionField } from './setup-option-handoff';

export type SetupOptionRow = {
  value: number;
  label: string;
  art: { boardType: BoardName; layoutId: number; sizeId: number; setIds: string } | null;
};

/** A whole-number route param, or null. */
export function readSetupOptionNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(parsed) ? parsed : null;
}

function artFor(boardName: BoardName, layoutId: number, sizeId: number | undefined) {
  if (sizeId === undefined) return null;
  const setIds = getBoardSetsForLayoutAndSize(boardName, layoutId, sizeId).map((set) => set.id);
  return setIds.length > 0 ? { boardType: boardName, layoutId, sizeId, setIds: setIds.join(',') } : null;
}

/** The rows for `field`, from the catalogue. Empty for a board or layout it doesn't know. */
export function setupOptionRows(
  field: SetupOptionField,
  boardName: BoardName,
  layoutId: number | null,
): SetupOptionRow[] {
  if (field === 'layout') {
    return getBoardLayouts(boardName).map((layout) => ({
      value: layout.id,
      label: cleanLayoutName(layout.name, boardName),
      art: artFor(boardName, layout.id, getBoardSizesForLayoutId(boardName, layout.id)[0]?.id),
    }));
  }
  if (layoutId === null) return [];
  return getBoardSizesForLayoutId(boardName, layoutId).map((size) => ({
    value: size.id,
    label: setupSizeLabel(size),
    art: artFor(boardName, layoutId, size.id),
  }));
}
