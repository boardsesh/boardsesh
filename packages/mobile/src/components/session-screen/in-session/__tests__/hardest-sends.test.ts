import { describe, expect, it } from 'vitest';
import { sortHardestSends, type HardestSend } from '../hardest-sends';

describe('sortHardestSends', () => {
  it('orders collapsed V grades by numeric difficulty id when available', () => {
    const sorted = sortHardestSends([
      { userId: 'first', difficultyId: 20, grade: '6c/V5' },
      { userId: 'second', difficultyId: 21, grade: '6c+/V5' },
    ] satisfies HardestSend[]);

    expect(sorted.map((send) => send.userId)).toEqual(['second', 'first']);
  });

  it('falls back to grade labels when difficulty ids are missing', () => {
    const sorted = sortHardestSends([
      { userId: 'first', difficultyId: null, grade: '6c/V5' },
      { userId: 'second', difficultyId: null, grade: '7a/V6' },
    ] satisfies HardestSend[]);

    expect(sorted.map((send) => send.userId)).toEqual(['second', 'first']);
  });
});
