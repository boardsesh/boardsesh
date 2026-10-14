import { describe, it, expect, vi } from 'vitest';
import {
  assertNeverRow,
  disabledOptionKeys,
  guardedButtonPress,
  isButtonRowPressable,
  selectedOptionLabel,
} from '../MoreForm.logic';
import type { MoreButtonRow, MoreOption } from '../MoreForm.types';

const options: MoreOption[] = [
  { key: 'system', label: 'System' },
  { key: 'en-US', label: 'English' },
  { key: 'es', label: 'Español' },
];

describe('selectedOptionLabel', () => {
  it('returns the label for the selected key', () => {
    expect(selectedOptionLabel(options, 'es')).toBe('Español');
  });

  it('returns an empty string when the key is not present', () => {
    expect(selectedOptionLabel(options, 'fr')).toBe('');
    expect(selectedOptionLabel([], 'system')).toBe('');
  });
});

describe('assertNeverRow', () => {
  it('throws when reached with an unexpected row kind', () => {
    // Cast through unknown: at runtime an unhandled kind would arrive here, and the
    // guard must throw rather than silently return.
    const rogue = { kind: 'mystery', key: 'x' } as unknown as never;
    expect(() => assertNeverRow(rogue)).toThrow(/Unhandled MoreRow kind/);
  });
});

describe('isButtonRowPressable', () => {
  it.each([
    [{}, true],
    [{ disabled: false, loading: false }, true],
    [{ disabled: true }, false],
    [{ loading: true }, false],
    [{ disabled: true, loading: true }, false],
  ])('%o → %s', (flags, expected) => {
    expect(isButtonRowPressable(flags)).toBe(expected);
  });
});

describe('guardedButtonPress', () => {
  const makeRow = (overrides: Partial<MoreButtonRow> = {}): MoreButtonRow => ({
    kind: 'button',
    key: 'sign-out',
    label: 'Sign out',
    onPress: vi.fn(),
    ...overrides,
  });

  it('fires the action for an idle row', () => {
    const row = makeRow();
    guardedButtonPress(row)();
    expect(row.onPress).toHaveBeenCalledOnce();
  });

  it.each([{ disabled: true }, { loading: true }])('refuses the press when %o', (flags) => {
    const row = makeRow(flags);
    guardedButtonPress(row)();
    expect(row.onPress).not.toHaveBeenCalled();
  });

  it('reads the row when pressed, so a press queued before loading began is dropped', () => {
    const row = makeRow();
    const handlePress = guardedButtonPress(row);
    row.loading = true;
    handlePress();
    expect(row.onPress).not.toHaveBeenCalled();
  });
});

describe('disabledOptionKeys', () => {
  it('refuses every option when the whole row is disabled', () => {
    expect(disabledOptionKeys(options, true, new Set(['es']))).toEqual(new Set(['system', 'en-US', 'es']));
  });

  it("passes the row's own disabled keys through when the row is enabled", () => {
    const disabledKeys = new Set(['es']);
    expect(disabledOptionKeys(options, false, disabledKeys)).toBe(disabledKeys);
    expect(disabledOptionKeys(options, undefined, disabledKeys)).toBe(disabledKeys);
  });

  it('refuses nothing when neither applies', () => {
    expect(disabledOptionKeys(options, undefined)).toBeUndefined();
  });
});
