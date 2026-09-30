import { describe, expect, it } from 'vitest';
import {
  bandColor,
  difficultyIdFromGrade,
  gradeBand,
  gradeBandFromId,
  gradeLabel,
  gradeLabelFromId,
  gradeOptions,
} from './grades';

describe('grades', () => {
  it('reads the difficulty id from catalogue grade strings', () => {
    expect(difficultyIdFromGrade('6b+/V4')).toBe(19);
    expect(difficultyIdFromGrade('6B+')).toBe(19);
    expect(difficultyIdFromGrade(null)).toBeNull();
    expect(difficultyIdFromGrade('not a grade')).toBeNull();
  });

  it('formats grades in Font, V or both', () => {
    expect(gradeLabel('6b+/V4', 'font')).toBe('6B+');
    expect(gradeLabel('6b+/V4', 'v-grade')).toBe('V4+');
    expect(gradeLabel('7a/V6', 'both')).toBe('V6 / 7A');
    expect(gradeLabelFromId(22, 'font')).toBe('7A');
    // Grades can arrive as averages.
    expect(gradeLabelFromId(21.6, 'font')).toBe('7A');
  });

  it('starts the MoonBoard grade list at 5+ (5a)', () => {
    const [easiest] = gradeOptions('moonboard', 'font');
    expect(easiest).toEqual({ difficultyId: 13, label: '5A' });
    expect(gradeOptions('tension', 'font')[0].difficultyId).toBe(10);
  });

  it('puts grades in the seven Graphite bands, however the grade is written', () => {
    expect(gradeBand('6a/V3')).toBe(1);
    expect(gradeBand('6a+/V3')).toBe(1);
    expect(gradeBand('6b/V4')).toBe(2);
    expect(gradeBand('6B+')).toBe(2);
    expect(gradeBand('6c/V5')).toBe(3);
    expect(gradeBand('7a+/V7')).toBe(4);
    expect(gradeBand('7b/V8')).toBe(5);
    expect(gradeBand('7c+/V10')).toBe(6);
    expect(gradeBand('8a/V11')).toBe(7);
    expect(gradeBand('8c+/V16')).toBe(7);
    // V-only labels use the V ranges.
    expect(gradeBand('V4+')).toBe(2);
    expect(gradeBand('V9')).toBe(6);
    expect(gradeBand(null)).toBe(0);
    expect(gradeBand('not a grade')).toBe(0);
  });

  it('bands difficulty ids and finds the band colour', () => {
    expect(gradeBandFromId(13)).toBe(1);
    expect(gradeBandFromId(19)).toBe(2);
    expect(gradeBandFromId(21.4)).toBe(3);
    expect(gradeBandFromId(null)).toBe(0);
    const ramp = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];
    expect(bandColor(ramp, 3)).toBe('g3');
    expect(bandColor(ramp, 0)).toBeUndefined();
  });
});
