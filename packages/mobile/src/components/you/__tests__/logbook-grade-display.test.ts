import { describe, it, expect } from 'vitest';
import { deriveLogbookGradeDisplay } from '../logbook-grade-display';

describe('deriveLogbookGradeDisplay', () => {
  it('shows no consensus secondary when the logged grade matches the consensus', () => {
    expect(deriveLogbookGradeDisplay(10, 10)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: false });
  });

  it('shows the consensus secondary when the logged grade differs from the consensus', () => {
    expect(deriveLogbookGradeDisplay(8, 9)).toEqual({ showConsensusSecondary: true, gradeIsConsensus: false });
  });

  it('marks the grade as consensus-sourced for an ungraded tick that has a consensus', () => {
    expect(deriveLogbookGradeDisplay(null, 9)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: true });
    expect(deriveLogbookGradeDisplay(undefined, 9)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: true });
  });

  it('shows neither when there is no consensus to compare against', () => {
    expect(deriveLogbookGradeDisplay(null, null)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: false });
    expect(deriveLogbookGradeDisplay(10, null)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: false });
  });
});
