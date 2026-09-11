import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { resolveGradeErrorLabel } from '../climb-method';

// t() returns the key, so the label is directly assertable.
const t = ((key: string) => key) as unknown as TFunction<'climbs'>;

describe('resolveGradeErrorLabel', () => {
  it('returns the "stiff" label when the crowd average notably outgrades the display grade', () => {
    expect(resolveGradeErrorLabel(0.8, 10, t)).toBe('card.gradeError.stiff');
  });

  it('returns the "soft" label when the crowd average notably undergrades the display grade', () => {
    expect(resolveGradeErrorLabel(-0.8, 10, t)).toBe('card.gradeError.soft');
  });

  it('returns null below the notability threshold', () => {
    expect(resolveGradeErrorLabel(0.1, 10, t)).toBeNull();
  });

  it('returns null below the minimum ascent count', () => {
    expect(resolveGradeErrorLabel(2.0, 1, t)).toBeNull();
  });

  it('returns null for a missing difficulty_error', () => {
    expect(resolveGradeErrorLabel(null, 10, t)).toBeNull();
    expect(resolveGradeErrorLabel(undefined, 10, t)).toBeNull();
  });

  it('parses a string difficulty_error, the shape the wire format carries', () => {
    expect(resolveGradeErrorLabel('0.6', 10, t)).toBe('card.gradeError.stiff');
  });
});
