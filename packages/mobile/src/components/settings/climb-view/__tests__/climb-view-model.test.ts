import { describe, expect, it, vi } from 'vitest';
import { buildClimbViewModel, type ClimbViewModelInput } from '../climb-view-model';
import type { MoreRow } from '../../../MoreForm.types';

function makeInput(overrides: Partial<ClimbViewModelInput['buttons']> = {}): ClimbViewModelInput {
  return {
    buttons: {
      title: 'Buttons',
      settingsFooter: 'Order lives in View options',
      positionLabel: 'Position',
      positionFooter: 'Log and Board light stay',
      positionOptions: [
        { key: 'below', label: 'Below the board' },
        { key: 'above', label: 'Above the board' },
      ],
      position: 'below',
      onPositionChange: vi.fn(),
      previousNextLabel: 'Previous and next',
      previousNextDescription: 'Swiping still works',
      previousNext: true,
      onPreviousNextChange: vi.fn(),
      controls: [
        { id: 'queue', label: 'Queue', visible: true, movable: true },
        { id: 'mirror', label: 'Mirror', description: 'Only on boards that mirror', visible: false, movable: true },
        { id: 'favorite', label: 'Favorite', visible: true, movable: true },
      ],
      onVisibleChange: vi.fn(),
      restoreDefaultsLabel: 'Restore defaults',
      canRestoreDefaults: true,
      onRestoreDefaults: vi.fn(),
      preview: 'preview-node',
      previewHeight: 132,
      ...overrides,
    },
    belowTheClimb: { key: 'climbDrawer', title: 'Below the climb', rows: [] },
  };
}

function rowsOf(input: ClimbViewModelInput): MoreRow[] {
  return buildClimbViewModel(input).sections.flatMap((section) => section.rows);
}

function findRow(input: ClimbViewModelInput, key: string): MoreRow {
  const row = rowsOf(input).find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildClimbViewModel', () => {
  it('runs the buttons first, then below the climb, top to bottom as the player draws them', () => {
    expect(buildClimbViewModel(makeInput()).sections.map((section) => section.key)).toEqual([
      'buttonsPosition',
      'buttons',
      'climbDrawer',
    ]);
  });

  it('hosts the preview at its fixed height above the position control', () => {
    const [preview, position] = buildClimbViewModel(makeInput()).sections[0].rows;
    expect(preview).toEqual({ kind: 'custom', key: 'preview', content: 'preview-node', height: 132 });
    if (position?.kind !== 'segmented') throw new Error('position is not segmented');
    expect(position.selectedKey).toBe('below');
  });

  it('hands a position choice on', () => {
    const onPositionChange = vi.fn();
    const row = findRow(makeInput({ onPositionChange }), 'buttonsPosition');
    if (row.kind !== 'segmented') throw new Error('position is not segmented');
    row.onSelect('above');
    expect(onPositionChange).toHaveBeenCalledWith('above');
  });

  // Switches only: the order changes in View options, so the rows simply follow it.
  it('lists Previous and next, then a switch per button in the saved order, then Restore defaults', () => {
    const rows = buildClimbViewModel(makeInput()).sections[1].rows;
    expect(rows.map((row) => row.key)).toEqual([
      'previousNext',
      'button.queue',
      'button.mirror',
      'button.favorite',
      'restoreButtonDefaults',
    ]);
    expect(buildClimbViewModel(makeInput()).sections[1].footer).toBe('Order lives in View options');
  });

  it('carries each switch state and subtitle, and flips the right button', () => {
    const onVisibleChange = vi.fn();
    const mirror = findRow(makeInput({ onVisibleChange }), 'button.mirror');
    if (mirror.kind !== 'toggle') throw new Error('not a toggle');
    expect(mirror.value).toBe(false);
    expect(mirror.subtitle).toBe('Only on boards that mirror');
    mirror.onValueChange(true);
    expect(onVisibleChange).toHaveBeenCalledWith('mirror', true);
  });

  it('greys out Restore defaults while nothing differs', () => {
    const restore = findRow(makeInput({ canRestoreDefaults: false }), 'restoreButtonDefaults');
    if (restore.kind !== 'button') throw new Error('not a button');
    expect(restore.disabled).toBe(true);
  });
});
