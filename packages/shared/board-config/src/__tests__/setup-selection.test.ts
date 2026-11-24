import { describe, expect, it } from 'vitest';
import {
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  getDefaultBoardSizeForLayout,
} from '../board-catalogue-cascade';
import { getBoardAngleOptions } from '../board-data';
import {
  initialSetupSelection,
  isOfferedSetupAngle,
  isSetupChanged,
  isSetupSelectionComplete,
  selectSetupAngle,
  selectSetupLayout,
  selectSetupSize,
  setupSelectionOptions,
  setupSelectionReducer,
  toggleSetupSet,
  toSuggestedSetup,
  type SetupSelection,
  type SetupSelectionBoard,
} from '../setup-selection';

// Real catalogue rows, found rather than hardcoded, so a catalogue refresh
// doesn't break the reset rules this file is about.
function kilterLayoutWithSizes(minimumSizes: number) {
  const layout = getBoardLayouts('kilter').find(
    (candidate) => getBoardSizesForLayoutId('kilter', candidate.id).length >= minimumSizes,
  );
  if (!layout) throw new Error(`No Kilter layout with ${minimumSizes} sizes in the catalogue`);
  return layout;
}

const multiSizeLayout = kilterLayoutWithSizes(2);
const [firstSize, secondSize] = getBoardSizesForLayoutId('kilter', multiSizeLayout.id);
const firstSizeSetIds = getBoardSetsForLayoutAndSize('kilter', multiSizeLayout.id, firstSize.id).map((set) => set.id);
const otherLayout = getBoardLayouts('kilter').find(
  (candidate) => candidate.id !== multiSizeLayout.id && getDefaultBoardSizeForLayout('kilter', candidate.id) != null,
);
if (!otherLayout) throw new Error('Need a second Kilter layout with a default size');

const kilterBoard = (overrides: Partial<SetupSelectionBoard> = {}): SetupSelectionBoard => ({
  boardType: 'kilter',
  layoutId: multiSizeLayout.id,
  sizeId: firstSize.id,
  setIds: [...firstSizeSetIds].reverse().join(','),
  angle: 40,
  isAngleAdjustable: true,
  ...overrides,
});

function initial(overrides: Partial<SetupSelectionBoard> = {}): SetupSelection {
  const selection = initialSetupSelection(kilterBoard(overrides));
  if (!selection) throw new Error('Expected a selection');
  return selection;
}

describe('initialSetupSelection', () => {
  it("starts on the board's current setup", () => {
    expect(initial()).toEqual({
      boardName: 'kilter',
      layoutId: multiSizeLayout.id,
      sizeId: firstSize.id,
      setIds: [...firstSizeSetIds].reverse(),
      angle: 40,
      angleIsFixed: false,
    });
  });

  it('marks a board that does not tilt as fixed-angle', () => {
    expect(initial({ isAngleAdjustable: false }).angleIsFixed).toBe(true);
  });

  it('returns null for a board type this build does not know', () => {
    expect(initialSetupSelection(kilterBoard({ boardType: 'not-a-board' }))).toBeNull();
    expect(initialSetupSelection(kilterBoard({ boardType: '' }))).toBeNull();
  });

  it("drops a set the catalogue doesn't list for the layout and size, so every selected set can be toggled", () => {
    const hiddenSetId = Math.max(...firstSizeSetIds) + 1_000;
    const selection = initial({ setIds: [hiddenSetId, ...firstSizeSetIds].join(',') });
    expect(selection.setIds).toEqual(firstSizeSetIds);
    // Unticking a listed set removes that one, not the hidden id.
    expect(toggleSetupSet(selection, firstSizeSetIds[0]).setIds).toEqual(firstSizeSetIds.slice(1));
  });

  it('opens a board carrying an unlisted set as unchanged; toggling a real set changes it', () => {
    const hiddenSetId = Math.max(...firstSizeSetIds) + 1_000;
    const current = {
      layoutId: multiSizeLayout.id,
      sizeId: firstSize.id,
      setIds: [hiddenSetId, ...firstSizeSetIds].join(','),
    };
    const selection = initial({ setIds: current.setIds });
    expect(isSetupChanged(selection, current)).toBe(false);
    const toggled = toggleSetupSet(selection, firstSizeSetIds[0]);
    expect(isSetupChanged(toggled, current)).toBe(true);
    // Back on: unchanged again.
    expect(isSetupChanged(toggleSetupSet(toggled, firstSizeSetIds[0]), current)).toBe(false);
  });

  it('keeps no sets for a layout and size the catalogue does not know', () => {
    expect(initial({ layoutId: 987_654 }).setIds).toEqual([]);
  });
});

describe('isOfferedSetupAngle', () => {
  it('accepts the angles some client offers, the MoonBoard wide range included', () => {
    expect(isOfferedSetupAngle('kilter', 40)).toBe(true);
    expect(isOfferedSetupAngle('moonboard', 25)).toBe(true);
    expect(isOfferedSetupAngle('moonboard', 30)).toBe(true);
    expect(isOfferedSetupAngle('grasshopper', -5)).toBe(true);
  });

  it('refuses an angle no Angle row offers, even one the write contracts route', () => {
    expect(isOfferedSetupAngle('kilter', 33)).toBe(false);
    expect(isOfferedSetupAngle('moonboard', 72)).toBe(false);
    expect(isOfferedSetupAngle('kilter', -5)).toBe(false);
    expect(isOfferedSetupAngle('not-a-board', 40)).toBe(false);
  });
});

describe('the reset rules match the board builder', () => {
  it('a layout change picks its default size and every set of that size', () => {
    const next = selectSetupLayout(initial(), otherLayout.id);
    const defaultSizeId = getDefaultBoardSizeForLayout('kilter', otherLayout.id);
    expect(next.layoutId).toBe(otherLayout.id);
    expect(next.sizeId).toBe(defaultSizeId);
    expect(next.setIds).toEqual(
      getBoardSetsForLayoutAndSize('kilter', otherLayout.id, defaultSizeId!).map((set) => set.id),
    );
  });

  it('picking the same layout again still resets the size and sets', () => {
    const narrowed = toggleSetupSet(selectSetupSize(initial(), secondSize.id), firstSizeSetIds[0]);
    const again = selectSetupLayout(narrowed, multiSizeLayout.id);
    const defaultSizeId = getDefaultBoardSizeForLayout('kilter', multiSizeLayout.id);
    expect(again.sizeId).toBe(defaultSizeId);
    expect(again.setIds).toEqual(
      getBoardSetsForLayoutAndSize('kilter', multiSizeLayout.id, defaultSizeId!).map((set) => set.id),
    );
  });

  it('a layout with no default size clears the size and sets', () => {
    const next = selectSetupLayout(initial(), 987_654);
    expect(next.sizeId).toBeNull();
    expect(next.setIds).toEqual([]);
  });

  it('a size change picks every set of the new size and keeps the layout', () => {
    const next = selectSetupSize(initial(), secondSize.id);
    expect(next.layoutId).toBe(multiSizeLayout.id);
    expect(next.sizeId).toBe(secondSize.id);
    expect(next.setIds).toEqual(
      getBoardSetsForLayoutAndSize('kilter', multiSizeLayout.id, secondSize.id).map((set) => set.id),
    );
  });

  it('a size change without a layout has no sets to pick', () => {
    const next = selectSetupSize({ ...initial(), layoutId: null }, secondSize.id);
    expect(next.setIds).toEqual([]);
  });

  it('a set toggles off and back on, at the end', () => {
    const [firstSetId] = firstSizeSetIds;
    const off = toggleSetupSet(initial(), firstSetId);
    expect(off.setIds).not.toContain(firstSetId);
    const on = toggleSetupSet(off, firstSetId);
    expect(on.setIds[on.setIds.length - 1]).toBe(firstSetId);
  });

  it('never changes the board type or the angle', () => {
    const start = initial({ isAngleAdjustable: false, angle: 25 });
    const moved = toggleSetupSet(selectSetupSize(selectSetupLayout(start, otherLayout.id), secondSize.id), 1);
    expect(moved.boardName).toBe('kilter');
    expect(moved.angle).toBe(25);
    expect(moved.angleIsFixed).toBe(true);
  });

  it('works on the board builder cascade, which has no angle', () => {
    const cascade = { boardName: 'kilter' as const, layoutId: null, sizeId: null, setIds: [] as number[] };
    const next = selectSetupLayout(cascade, multiSizeLayout.id);
    expect(next).not.toHaveProperty('angle');
    expect(next.layoutId).toBe(multiSizeLayout.id);
  });
});

describe('selectSetupAngle', () => {
  it('sets the angle of a board that does not tilt', () => {
    expect(selectSetupAngle(initial({ isAngleAdjustable: false }), 30).angle).toBe(30);
  });

  it('leaves a board that tilts alone', () => {
    const start = initial();
    expect(selectSetupAngle(start, 30)).toBe(start);
  });
});

describe('setupSelectionReducer', () => {
  it('runs the same transitions', () => {
    const start = initial({ isAngleAdjustable: false });
    expect(setupSelectionReducer(start, { type: 'selectLayout', layoutId: otherLayout.id })).toEqual(
      selectSetupLayout(start, otherLayout.id),
    );
    expect(setupSelectionReducer(start, { type: 'selectSize', sizeId: secondSize.id })).toEqual(
      selectSetupSize(start, secondSize.id),
    );
    expect(setupSelectionReducer(start, { type: 'toggleSet', setId: firstSizeSetIds[0] })).toEqual(
      toggleSetupSet(start, firstSizeSetIds[0]),
    );
    expect(setupSelectionReducer(start, { type: 'selectAngle', angle: 15 }).angle).toBe(15);
  });

  it("resets to the board's current setup", () => {
    const moved = selectSetupSize(initial(), secondSize.id);
    expect(setupSelectionReducer(moved, { type: 'reset', board: kilterBoard() })).toEqual(initial());
    expect(setupSelectionReducer(moved, { type: 'reset', board: kilterBoard({ boardType: 'nope' }) })).toBe(moved);
  });
});

describe('setupSelectionOptions', () => {
  it('offers the cascade for the selection', () => {
    const options = setupSelectionOptions(initial(), { wideAnglesEnabled: false });
    expect(options.layouts).toEqual(getBoardLayouts('kilter'));
    expect(options.sizes).toEqual(getBoardSizesForLayoutId('kilter', multiSizeLayout.id));
    expect(options.sets).toEqual(getBoardSetsForLayoutAndSize('kilter', multiSizeLayout.id, firstSize.id));
  });

  it('offers angles only for a board that does not tilt', () => {
    expect(setupSelectionOptions(initial(), { wideAnglesEnabled: false }).angles).toEqual([]);
    expect(setupSelectionOptions(initial({ isAngleAdjustable: false }), { wideAnglesEnabled: false }).angles).toEqual(
      getBoardAngleOptions('kilter', false),
    );
  });

  it('offers no sizes or sets until the level above is picked', () => {
    const options = setupSelectionOptions({ ...initial(), layoutId: null, sizeId: null }, { wideAnglesEnabled: false });
    expect(options.sizes).toEqual([]);
    expect(options.sets).toEqual([]);
  });
});

describe('isSetupChanged', () => {
  const current = { layoutId: multiSizeLayout.id, sizeId: firstSize.id, setIds: firstSizeSetIds.join(','), angle: 40 };

  it('is false for the current setup, whatever the set order', () => {
    expect(isSetupChanged(initial(), current)).toBe(false);
  });

  it('is true for another layout, size or set list', () => {
    expect(isSetupChanged(selectSetupLayout(initial(), otherLayout.id), current)).toBe(true);
    expect(isSetupChanged(selectSetupSize(initial(), secondSize.id), current)).toBe(true);
    expect(isSetupChanged(toggleSetupSet(initial(), firstSizeSetIds[0]), current)).toBe(true);
  });

  it('counts the angle only on a board that does not tilt', () => {
    expect(isSetupChanged({ ...initial(), angle: 20 }, current)).toBe(false);
    expect(isSetupChanged(selectSetupAngle(initial({ isAngleAdjustable: false }), 20), current)).toBe(true);
    expect(isSetupChanged(initial({ isAngleAdjustable: false }), current)).toBe(false);
  });
});

describe('toSuggestedSetup', () => {
  it('serialises the sets in canonical order and leaves the angle out on a board that tilts', () => {
    const selection = { ...initial(), setIds: [10, 2, 2] };
    expect(toSuggestedSetup(selection)).toEqual({
      layoutId: multiSizeLayout.id,
      sizeId: firstSize.id,
      setIds: '2,10',
      angle: null,
    });
  });

  it('carries the angle of a board that does not tilt', () => {
    expect(toSuggestedSetup(selectSetupAngle(initial({ isAngleAdjustable: false }), 35))?.angle).toBe(35);
  });

  it('is null while the selection is incomplete', () => {
    const noSets = { ...initial(), setIds: [] };
    expect(isSetupSelectionComplete(noSets)).toBe(false);
    expect(toSuggestedSetup(noSets)).toBeNull();
    expect(toSuggestedSetup(selectSetupLayout(initial(), 987_654))).toBeNull();
    expect(isSetupSelectionComplete(initial())).toBe(true);
  });
});
