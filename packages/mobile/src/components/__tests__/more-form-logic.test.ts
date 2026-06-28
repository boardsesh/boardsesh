import { describe, it, expect } from 'vitest';
import { assertNeverRow, selectedOptionLabel } from '../MoreForm.logic';
import type { MoreOption } from '../MoreForm.types';

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
