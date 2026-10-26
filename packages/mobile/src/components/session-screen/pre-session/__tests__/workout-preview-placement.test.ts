import { describe, expect, it } from 'vitest';
import { resolveWorkoutPreviewPlacement } from '../workout-preview-placement';

const openDuoSessionTab = { phoneSplit: true, hasPaneSlot: true, isFocused: true };

describe('resolveWorkoutPreviewPlacement', () => {
  it('moves the preview into the split pane on the focused Session tab of an open Duo', () => {
    expect(resolveWorkoutPreviewPlacement({ ...openDuoSessionTab, hasWorkoutBlocks: true })).toBe('pane');
  });

  it('has no preview without a workout block, so the pane keeps the board', () => {
    expect(resolveWorkoutPreviewPlacement({ ...openDuoSessionTab, hasWorkoutBlocks: false })).toBe('none');
    expect(
      resolveWorkoutPreviewPlacement({
        phoneSplit: false,
        hasPaneSlot: false,
        isFocused: true,
        hasWorkoutBlocks: false,
      }),
    ).toBe('none');
  });

  it('keeps the stacked layout everywhere else', () => {
    // A phone, a folded or portrait Duo, an iPad: no split.
    expect(resolveWorkoutPreviewPlacement({ ...openDuoSessionTab, phoneSplit: false, hasWorkoutBlocks: true })).toBe(
      'inline',
    );
    // The overlay host and the iPad shell have no pane slot.
    expect(resolveWorkoutPreviewPlacement({ ...openDuoSessionTab, hasPaneSlot: false, hasWorkoutBlocks: true })).toBe(
      'inline',
    );
    // Another screen covers Session (a root page, the player): the pane goes back to the board.
    expect(resolveWorkoutPreviewPlacement({ ...openDuoSessionTab, isFocused: false, hasWorkoutBlocks: true })).toBe(
      'inline',
    );
  });
});
