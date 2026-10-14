import { describe, expect, it, vi } from 'vitest';
import { buildBoardLightingModel, type BoardLightingModelInput } from '../board-lighting-model';
import type { MoreRow } from '../../../MoreForm.types';

function makeInput(overrides: Partial<BoardLightingModelInput> = {}): BoardLightingModelInput {
  return {
    t: (key: string) => key,
    lightOnSwipe: { enabled: true, onChange: vi.fn() },
    lightOnClimbTap: { enabled: false, onChange: vi.fn() },
    moonboardLightAdjacentHolds: null,
    autoDisconnect: { enabled: true, onChange: vi.fn() },
    autoDisconnectTimeout: {
      seconds: 30,
      options: [
        { seconds: 10, label: '10 seconds' },
        { seconds: 30, label: '30 seconds' },
      ],
      onChange: vi.fn(),
    },
    ...overrides,
  };
}

function findRow(input: BoardLightingModelInput, key: string): MoreRow {
  const row = buildBoardLightingModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildBoardLightingModel', () => {
  it('lists what lights the board, then auto-disconnect', () => {
    const model = buildBoardLightingModel(makeInput());
    expect(model.sections.map((section) => [section.key, section.rows.map((row) => row.key)])).toEqual([
      ['lighting', ['lightOnSwipe', 'lightOnClimbTap']],
      ['autoDisconnect', ['autoDisconnectBle', 'autoDisconnectTimeoutSeconds']],
    ]);
  });

  it('keeps both descriptions as footers, and leaves the page title off the first section', () => {
    const [lighting, autoDisconnect] = buildBoardLightingModel(makeInput()).sections;
    expect(lighting.title).toBeUndefined();
    expect(lighting.footer).toBe('settings:ble.lighting.description');
    expect(autoDisconnect.footer).toBe('settings:ble.autoDisconnect.description');
  });

  it('adds the MoonBoard extra-LED switch only for a MoonBoard', () => {
    const onChange = vi.fn();
    const row = findRow(
      makeInput({ moonboardLightAdjacentHolds: { enabled: true, onChange } }),
      'moonboardLightAdjacentHolds',
    );
    if (row.kind !== 'toggle') throw new Error('not a toggle');
    expect(row.value).toBe(true);
    row.onValueChange(false);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('selects a timeout by its seconds and ignores anything else', () => {
    const onChange = vi.fn();
    const input = makeInput();
    input.autoDisconnectTimeout.onChange = onChange;
    const row = findRow(input, 'autoDisconnectTimeoutSeconds');
    if (row.kind !== 'select') throw new Error('not a select');
    expect(row.selectedKey).toBe('30');
    expect(row.options).toEqual([
      { key: '10', label: '10 seconds' },
      { key: '30', label: '30 seconds' },
    ]);
    row.onSelect('10');
    row.onSelect('999');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it('hands each switch flip to its own handler', () => {
    const input = makeInput();
    const swipe = findRow(input, 'lightOnSwipe');
    if (swipe.kind !== 'toggle') throw new Error('not a toggle');
    swipe.onValueChange(false);
    expect(input.lightOnSwipe.onChange).toHaveBeenCalledWith(false);
    expect(input.lightOnClimbTap.onChange).not.toHaveBeenCalled();
  });
});
