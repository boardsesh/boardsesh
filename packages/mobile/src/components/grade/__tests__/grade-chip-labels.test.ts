import { describe, expect, it } from 'vitest';
import { distinctGradeChipLabels } from '../grade-chip-labels';

const SCALE = [
  { difficultyId: 10, name: '4a/V0' },
  { difficultyId: 11, name: '4b/V0' },
  { difficultyId: 12, name: '4c/V0' },
  { difficultyId: 13, name: '5a/V1' },
  { difficultyId: 14, name: '5b/V1' },
  { difficultyId: 15, name: '5c/V2' },
];

describe('distinctGradeChipLabels (#5960)', () => {
  it('never puts the same V label on two chips', () => {
    const labels = distinctGradeChipLabels(SCALE, 'v-grade');
    expect([...labels.values()]).toEqual(['V0 / 4A', 'V0 / 4B', 'V0 / 4C', 'V1 / 5A', 'V1 / 5B', 'V2']);
    expect(new Set(labels.values()).size).toBe(SCALE.length);
  });

  it('keeps a label that is already unique in the climber’s own format', () => {
    expect(distinctGradeChipLabels(SCALE, 'v-grade').get(15)).toBe('V2');
    expect([...distinctGradeChipLabels(SCALE, 'font').values()]).toEqual(['4A', '4B', '4C', '5A', '5B', '5C']);
  });
});
