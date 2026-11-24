import type { BoardName, BoardSetupInput } from '@boardsesh/shared-schema';
import type { LayoutData, ProductSizeData, SetData } from '@boardsesh/board-constants/product-sizes';
import {
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  getDefaultBoardSizeForLayout,
} from './board-catalogue-cascade';
import { getBoardAngleOptions } from './board-data';
import { toBoardName } from './board-name';
import { normaliseSetIds, parseSetIds } from './set-ids';
import type { Angle } from './types';

/**
 * Picking a board's setup within its own board type: layout, size, hold sets
 * and, on a board that doesn't tilt, angle. The "Set up wrong" report fields
 * (docs/product/directory-reports.md, "Suggested setup") hold their state here,
 * in the app and on www alike, and so does the app's board builder.
 *
 * The reset rules are the board builder's (`use-board-builder.ts`): each level
 * resets everything below it so the cascade stays consistent.
 * - A layout change picks that layout's default size and every set of it.
 * - A size change picks every set of the new size.
 * - A set toggles on its own.
 * Picking the same layout or size again resets the levels below it too.
 *
 * Pure: no React, no platform I/O. Each transition returns a new selection.
 */

/** The cascade the board builder and the report fields share. */
export type SetupCascade = {
  boardName: BoardName;
  layoutId: number | null;
  sizeId: number | null;
  /** Selected hold set ids, in the order they were picked. */
  setIds: number[];
};

export type SetupSelection = SetupCascade & {
  /** The angle row's value. Part of the setup only when {@link SetupSelection.angleIsFixed}. */
  angle: Angle;
  /** The board doesn't tilt (`isAngleAdjustable: false`), so its angle is part of its setup. */
  angleIsFixed: boolean;
};

/** A board's setup as `UserBoard` carries it. */
export type SetupSelectionBoard = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  isAngleAdjustable: boolean;
};

/** The setup to compare a selection against: the board as it is now. */
export type CurrentBoardSetup = {
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle?: number | null;
};

/**
 * The selection a board starts on: its current setup. Null for a board type
 * this build doesn't know.
 *
 * Only the sets the catalogue lists for the board's layout and size are kept,
 * so every selected set is one the Holds row shows and can toggle off. A board
 * carrying a set the catalogue doesn't list for its size starts without it,
 * and {@link isSetupChanged} leaves it out of the comparison too, so the
 * fields open unchanged.
 */
export function initialSetupSelection(board: SetupSelectionBoard): SetupSelection | null {
  const boardName = toBoardName(board.boardType);
  if (!boardName) return null;
  return {
    boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: listedSetIds(boardName, board),
    angle: board.angle,
    angleIsFixed: !board.isAngleAdjustable,
  };
}

/** The setup's sets the catalogue lists for its layout and size, in the setup's order. */
function listedSetIds(boardName: BoardName, setup: { layoutId: number; sizeId: number; setIds: string }): number[] {
  const listed = new Set(getBoardSetsForLayoutAndSize(boardName, setup.layoutId, setup.sizeId).map((set) => set.id));
  return parseSetIds(setup.setIds).filter((setId) => listed.has(setId));
}

/** Pick a layout: its default size and every set of that size come with it. */
export function selectSetupLayout<Selection extends SetupCascade>(selection: Selection, layoutId: number): Selection {
  const defaultSizeId = getDefaultBoardSizeForLayout(selection.boardName, layoutId);
  return {
    ...selection,
    layoutId,
    sizeId: defaultSizeId,
    setIds:
      defaultSizeId != null
        ? getBoardSetsForLayoutAndSize(selection.boardName, layoutId, defaultSizeId).map((set) => set.id)
        : [],
  };
}

/** Pick a size: every set of it comes with it, the common case (a "Full Ride" wall has them all). */
export function selectSetupSize<Selection extends SetupCascade>(selection: Selection, sizeId: number): Selection {
  return {
    ...selection,
    sizeId,
    setIds:
      selection.layoutId != null
        ? getBoardSetsForLayoutAndSize(selection.boardName, selection.layoutId, sizeId).map((set) => set.id)
        : [],
  };
}

/** Turn one hold set on or off. */
export function toggleSetupSet<Selection extends SetupCascade>(selection: Selection, setId: number): Selection {
  return {
    ...selection,
    setIds: selection.setIds.includes(setId)
      ? selection.setIds.filter((selectedSetId) => selectedSetId !== setId)
      : [...selection.setIds, setId],
  };
}

/** Pick the angle of a board that doesn't tilt. A board that tilts keeps its selection as it is. */
export function selectSetupAngle(selection: SetupSelection, angle: Angle): SetupSelection {
  if (!selection.angleIsFixed) return selection;
  return { ...selection, angle };
}

export type SetupSelectionAction =
  | { type: 'selectLayout'; layoutId: number }
  | { type: 'selectSize'; sizeId: number }
  | { type: 'toggleSet'; setId: number }
  | { type: 'selectAngle'; angle: Angle }
  | { type: 'reset'; board: SetupSelectionBoard };

/**
 * The transitions as a `useReducer` reducer. `reset` goes back to the board's
 * current setup; a board type this build doesn't know leaves the selection as it is.
 */
export function setupSelectionReducer(selection: SetupSelection, action: SetupSelectionAction): SetupSelection {
  switch (action.type) {
    case 'selectLayout':
      return selectSetupLayout(selection, action.layoutId);
    case 'selectSize':
      return selectSetupSize(selection, action.sizeId);
    case 'toggleSet':
      return toggleSetupSet(selection, action.setId);
    case 'selectAngle':
      return selectSetupAngle(selection, action.angle);
    case 'reset':
      return initialSetupSelection(action.board) ?? selection;
  }
}

export type SetupSelectionOptions = {
  layouts: LayoutData[];
  /** The sizes of the selected layout; empty until a layout is picked. */
  sizes: ProductSizeData[];
  /** The sets of the selected layout and size; empty until both are picked. */
  sets: SetData[];
  /** The angles to offer; empty for a board that tilts, whose angle row stays hidden. */
  angles: Angle[];
};

/**
 * What each row offers for this selection. `wideAnglesEnabled` is the
 * `moonboard-wide-angles` flag, as `getBoardAngleOptions` takes it.
 */
export function setupSelectionOptions(
  selection: SetupSelection,
  options: { wideAnglesEnabled: boolean },
): SetupSelectionOptions {
  const { boardName, layoutId, sizeId } = selection;
  return {
    layouts: getBoardLayouts(boardName),
    sizes: layoutId != null ? getBoardSizesForLayoutId(boardName, layoutId) : [],
    sets: layoutId != null && sizeId != null ? getBoardSetsForLayoutAndSize(boardName, layoutId, sizeId) : [],
    angles: selection.angleIsFixed ? getBoardAngleOptions(boardName, options.wideAnglesEnabled) : [],
  };
}

/**
 * Whether some client may offer this angle in the Angle row for this board
 * type: `getBoardAngleOptions` with the `moonboard-wide-angles` flag off or
 * on. The flag is a per-viewer UI rollout, so the server, which can't see the
 * viewer's flag, accepts the angles either answer offers. Stricter than the
 * write contracts' "any routable angle": a suggested setup's angle is picked
 * from the Angle row, never typed.
 */
export function isOfferedSetupAngle(boardType: string, angle: number): boolean {
  const boardName = toBoardName(boardType);
  if (!boardName) return false;
  return (
    getBoardAngleOptions(boardName, false).includes(angle) || getBoardAngleOptions(boardName, true).includes(angle)
  );
}

/** A layout, a size and at least one set are picked. */
export function isSetupSelectionComplete(selection: SetupCascade): boolean {
  return selection.layoutId != null && selection.sizeId != null && selection.setIds.length > 0;
}

/**
 * Whether the climber changed something: the selection differs from the
 * board's current setup as {@link initialSetupSelection} read it. Set order
 * and repeats don't count (`normaliseSetIds`), and neither does a set the
 * catalogue doesn't list for the current layout and size, which the selection
 * never holds: a board carrying one opens unchanged. The angle counts only on
 * a board that doesn't tilt.
 */
export function isSetupChanged(selection: SetupSelection, current: CurrentBoardSetup): boolean {
  if (selection.layoutId !== current.layoutId || selection.sizeId !== current.sizeId) return true;
  const currentSetIds = listedSetIds(selection.boardName, current).join(',');
  if (normaliseSetIds(selection.setIds.join(',')) !== normaliseSetIds(currentSetIds)) return true;
  return selection.angleIsFixed && selection.angle !== current.angle;
}

/**
 * The selection as `ReportBoardInput.suggestedSetup`, or null while it is
 * incomplete. Sets in canonical order; the angle only for a board that doesn't tilt.
 */
export function toSuggestedSetup(selection: SetupSelection): BoardSetupInput | null {
  if (selection.layoutId == null || selection.sizeId == null || selection.setIds.length === 0) return null;
  return {
    layoutId: selection.layoutId,
    sizeId: selection.sizeId,
    setIds: normaliseSetIds(selection.setIds.join(',')),
    angle: selection.angleIsFixed ? selection.angle : null,
  };
}

/** The setup field the bundled catalogue doesn't list, in cascade order. */
export type UnknownSetupField = 'layoutId' | 'sizeId' | 'setIds';

/**
 * The first part of a setup the bundled catalogue doesn't list, checked in
 * cascade order (layout, then the size on that layout, then the sets on that
 * size), or null when it lists all of it. The same order the server's
 * `UNKNOWN_BOARD_CONFIG` refusal names its `field` in, so the app can mark the
 * same input before the save goes out (#8151). `invalidSetIds` are the set ids
 * the layout and size don't have, ascending and without repeats.
 *
 * An incomplete setup (no layout or size yet) is not an unknown one: it
 * returns null, and the builder's Save stays off until it is complete.
 */
export function findUnknownSetupField(
  boardName: BoardName,
  setup: { layoutId: number | null; sizeId: number | null; setIds: readonly number[] },
): { field: UnknownSetupField; invalidSetIds: number[] } | null {
  const { layoutId, sizeId } = setup;
  if (layoutId == null || sizeId == null) return null;
  if (!getBoardLayouts(boardName).some((layout) => layout.id === layoutId)) {
    return { field: 'layoutId', invalidSetIds: [] };
  }
  if (!getBoardSizesForLayoutId(boardName, layoutId).some((size) => size.id === sizeId)) {
    return { field: 'sizeId', invalidSetIds: [] };
  }
  const listed = new Set(getBoardSetsForLayoutAndSize(boardName, layoutId, sizeId).map((set) => set.id));
  const invalidSetIds = [...new Set(setup.setIds)]
    .filter((setId) => !listed.has(setId))
    .sort((first, second) => first - second);
  return invalidSetIds.length > 0 ? { field: 'setIds', invalidSetIds } : null;
}
