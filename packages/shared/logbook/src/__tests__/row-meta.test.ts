import { describe, expect, it } from 'vitest';
import { displayedAttemptCount, logbookAttemptsKind, logbookNoteIsVisible, normalizeLogbookQuality } from '../row-meta';

describe('logbookAttemptsKind', () => {
  it('maps statuses to the climber-voiced kinds', () => {
    expect(logbookAttemptsKind('flash')).toBe('flash');
    expect(logbookAttemptsKind('send')).toBe('send');
    expect(logbookAttemptsKind('attempt')).toBe('project');
  });
});

describe('displayedAttemptCount', () => {
  it('floors imported zero/negative counts at 1', () => {
    expect(displayedAttemptCount(0)).toBe(1);
    expect(displayedAttemptCount(-2)).toBe(1);
    expect(displayedAttemptCount(6)).toBe(6);
  });
});

describe('normalizeLogbookQuality', () => {
  it("treats null and the edit sheet's cleared 0 as unset", () => {
    expect(normalizeLogbookQuality(null)).toBeNull();
    expect(normalizeLogbookQuality(undefined)).toBeNull();
    expect(normalizeLogbookQuality(0)).toBeNull();
  });

  it('passes 1-5 through and clamps defensively above', () => {
    expect(normalizeLogbookQuality(1)).toBe(1);
    expect(normalizeLogbookQuality(5)).toBe(5);
    expect(normalizeLogbookQuality(7)).toBe(5);
  });

  it('normalises defensive float input by rounding first', () => {
    expect(normalizeLogbookQuality(0.3)).toBeNull(); // rounds to 0 → unset, never "0★"
    expect(normalizeLogbookQuality(0.6)).toBe(1);
    expect(normalizeLogbookQuality(4.4)).toBe(4);
  });
});

describe('logbookNoteIsVisible', () => {
  it('hides null, empty, and whitespace-only comments', () => {
    expect(logbookNoteIsVisible(null)).toBe(false);
    expect(logbookNoteIsVisible('')).toBe(false);
    expect(logbookNoteIsVisible('   \n')).toBe(false);
    expect(logbookNoteIsVisible('heel hook the arete')).toBe(true);
  });
});
