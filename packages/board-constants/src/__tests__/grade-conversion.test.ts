import { describe, it, expect } from 'vite-plus/test';
import {
  MOONBOARD_SANDBAG_V_OFFSET,
  difficultyIdToVNumber,
  effectiveSendVNumber,
  gradeBandToDifficultyIds,
} from '../grade-conversion';

describe('difficultyIdToVNumber', () => {
  it('maps known difficulty ids to V numbers', () => {
    expect(difficultyIdToVNumber(10)).toBe(0); // 4a/V0
    expect(difficultyIdToVNumber(18)).toBe(4); // 6b/V4
    expect(difficultyIdToVNumber(22)).toBe(6); // 7a/V6
    expect(difficultyIdToVNumber(30)).toBe(13); // 8b/V13
  });

  it('rounds float difficulty (display_difficulty is doublePrecision)', () => {
    expect(difficultyIdToVNumber(18.4)).toBe(4);
    expect(difficultyIdToVNumber(21.6)).toBe(6);
  });

  it('returns null outside the grade table', () => {
    expect(difficultyIdToVNumber(0)).toBeNull();
    expect(difficultyIdToVNumber(99)).toBeNull();
  });
});

describe('effectiveSendVNumber', () => {
  it('de-sandbags MoonBoard sends by the offset', () => {
    expect(effectiveSendVNumber('moonboard', 18)).toBe(4 + MOONBOARD_SANDBAG_V_OFFSET); // MoonBoard V4 -> Kilter V6
    expect(effectiveSendVNumber('moonboard', 22)).toBe(6 + MOONBOARD_SANDBAG_V_OFFSET);
  });

  it('leaves non-MoonBoard sends unchanged', () => {
    expect(effectiveSendVNumber('kilter', 18)).toBe(4);
    expect(effectiveSendVNumber('tension', 22)).toBe(6);
  });

  it('returns null for unknown difficulty', () => {
    expect(effectiveSendVNumber('kilter', 99)).toBeNull();
  });
});

describe('gradeBandToDifficultyIds', () => {
  it('builds a [max-3, max+1] band around a V6 max -> V3..V7', () => {
    // V3 -> difficulty ids 16/17, V7 -> id 23
    expect(gradeBandToDifficultyIds(6, 3, 1)).toEqual({ minDifficultyId: 16, maxDifficultyId: 23 });
  });

  it('a MoonBoard-V4 climber recommends a Kilter V3..V7 band', () => {
    const maxV = effectiveSendVNumber('moonboard', 18)!; // V6
    expect(gradeBandToDifficultyIds(maxV, 3, 1)).toEqual({ minDifficultyId: 16, maxDifficultyId: 23 });
  });

  it('clamps the low end at V0', () => {
    // V0 -> ids 10/11/12 (min 10), V1 -> ids 13/14 (max 14)
    expect(gradeBandToDifficultyIds(0, 3, 1)).toEqual({ minDifficultyId: 10, maxDifficultyId: 14 });
  });
});
