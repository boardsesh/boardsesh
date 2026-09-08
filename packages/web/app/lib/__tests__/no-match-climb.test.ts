import { describe, it, expect } from 'vite-plus/test';
import { isNoMatchClimb } from '../no-match-climb';

describe('isNoMatchClimb', () => {
  it('returns false for null/undefined/empty description', () => {
    expect(isNoMatchClimb(null)).toBe(false);
    expect(isNoMatchClimb(undefined)).toBe(false);
    expect(isNoMatchClimb('')).toBe(false);
  });

  it('detects common "no match" variations (case-insensitive)', () => {
    expect(isNoMatchClimb('No matching')).toBe(true);
    expect(isNoMatchClimb('No match')).toBe(true);
    expect(isNoMatchClimb('no matching')).toBe(true);
    expect(isNoMatchClimb('NO MATCHING')).toBe(true);
    expect(isNoMatchClimb('No Matching')).toBe(true);
    expect(isNoMatchClimb('No matches')).toBe(true);
    expect(isNoMatchClimb('No matchy')).toBe(true);
    expect(isNoMatchClimb('No matchies')).toBe(true);
    expect(isNoMatchClimb('No matching!')).toBe(true);
    expect(isNoMatchClimb('No matching.')).toBe(true);
    expect(isNoMatchClimb('No matching :)')).toBe(true);
    expect(isNoMatchClimb('No matching. Some extra notes')).toBe(true);
  });

  // #5127: setters more often append the declaration than lead with it.
  it('detects a declaration appended after the setter prose', () => {
    expect(isNoMatchClimb('Kick board is off. No matching.')).toBe(true);
    expect(isNoMatchClimb('Remedial training for my terrible open hip climbing\nNo matching')).toBe(true);
  });

  it('returns false for unrelated descriptions', () => {
    expect(isNoMatchClimb('A fun climb')).toBe(false);
    expect(isNoMatchClimb('V3')).toBe(false);
    expect(isNoMatchClimb('Campus')).toBe(false);
    expect(isNoMatchClimb('Matching allowed')).toBe(false);
    expect(isNoMatchClimb('Match only the finish hold')).toBe(false);
    // Ends with the phrase, but is not declaring the rule.
    expect(isNoMatchClimb('You can match start hold but the rest is no matching')).toBe(false);
    expect(isNoMatchClimb('Campus, no match')).toBe(false);
  });
});
