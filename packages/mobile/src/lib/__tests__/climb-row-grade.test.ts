import { describe, it, expect } from 'vitest';
import { deriveClimbRowGrade } from '../climb-row-grade';

// The rule under test: the grade column shows ONE grade (yours, else
// Boardsesh's, else the community's), and the community's grade leads the detail
// line only when the column shows another grade that reads differently.
describe('deriveClimbRowGrade', () => {
  describe('the grade in the column', () => {
    it('is the community grade for a climb the climber never graded', () => {
      // The common case, and the row a climber with no ticks sees everywhere.
      expect(deriveClimbRowGrade({ personalLabel: null, boardseshLabel: null, communityLabel: 'V4' })).toEqual({
        source: 'community',
        label: 'V4',
        markedAsMine: false,
        communityGradeToken: null,
      });
    });

    it('is the Boardsesh grade when the climber has those on and no grade of their own', () => {
      const grade = deriveClimbRowGrade({ personalLabel: null, boardseshLabel: 'V5', communityLabel: 'V4' });

      expect(grade.source).toBe('boardsesh');
      expect(grade.label).toBe('V5');
      expect(grade.markedAsMine).toBe(false);
    });

    it('is the climber’s own grade over both of the others', () => {
      const grade = deriveClimbRowGrade({ personalLabel: 'V10', boardseshLabel: 'V5', communityLabel: 'V4' });

      expect(grade.source).toBe('personal');
      expect(grade.label).toBe('V10');
    });

    it('is empty for a climb nobody has graded', () => {
      expect(deriveClimbRowGrade({ personalLabel: null, boardseshLabel: null, communityLabel: null })).toEqual({
        source: 'none',
        label: '',
        markedAsMine: false,
        communityGradeToken: null,
      });
    });

    it('treats an empty label as no label at all', () => {
      // The grade resolver hands back '' for a climb whose stats row has no
      // difficulty, and that must read as "no community grade", not as a grade.
      expect(deriveClimbRowGrade({ communityLabel: '' }).source).toBe('none');
      expect(deriveClimbRowGrade({ personalLabel: '', communityLabel: 'V4' }).source).toBe('community');
      expect(deriveClimbRowGrade({ boardseshLabel: '', communityLabel: 'V4' }).source).toBe('community');
    });

    it('treats an unfetched logbook exactly like a climb you never graded', () => {
      // Callers pass nothing for both "no grade" and "not known yet": guessing
      // "no ticks" from an empty bucket is what caused #3940.
      expect(deriveClimbRowGrade({ personalLabel: undefined, communityLabel: 'V4' })).toEqual(
        deriveClimbRowGrade({ personalLabel: null, communityLabel: 'V4' }),
      );
    });
  });

  // The mark is today's rule, unchanged: `derivePersonalGradeDisplay` decides it
  // against the grade the climber's own replaced.
  describe('the person mark', () => {
    it('marks the climber’s grade when it reads differently from the one it replaced', () => {
      expect(deriveClimbRowGrade({ personalLabel: 'V10', communityLabel: 'V0' }).markedAsMine).toBe(true);
      expect(
        deriveClimbRowGrade({ personalLabel: 'V10', boardseshLabel: 'V5', communityLabel: 'V4' }).markedAsMine,
      ).toBe(true);
    });

    it('stays off when the climber’s grade reads the same as the one it replaced', () => {
      // Ids 10, 11 and 12 are 4a, 4b and 4c, which all render "V0": a climber who
      // logged 4c on a climb listed as 4a has not disagreed with anything on screen.
      expect(deriveClimbRowGrade({ personalLabel: 'V0', communityLabel: 'V0' }).markedAsMine).toBe(false);
      expect(
        deriveClimbRowGrade({ personalLabel: 'V5', boardseshLabel: 'V5', communityLabel: 'V4' }).markedAsMine,
      ).toBe(false);
    });

    it('marks the climber’s grade when it is the only one there is', () => {
      // A draft, or an angle with no stats row.
      expect(deriveClimbRowGrade({ personalLabel: 'V7' }).markedAsMine).toBe(true);
    });

    it('never marks a grade that is not the climber’s', () => {
      expect(deriveClimbRowGrade({ communityLabel: 'V4' }).markedAsMine).toBe(false);
      expect(deriveClimbRowGrade({ boardseshLabel: '≈V5', communityLabel: 'V4' }).markedAsMine).toBe(false);
    });
  });

  describe('the community grade token', () => {
    it('leads the detail line when the climber’s own grade reads differently', () => {
      // The Woods case in #4796 / #4828: set at V0, you called it V10.
      expect(deriveClimbRowGrade({ personalLabel: 'V10', communityLabel: 'V0' })).toEqual({
        source: 'personal',
        label: 'V10',
        markedAsMine: true,
        communityGradeToken: 'V0',
      });
    });

    it('is left out when the climber’s grade reads the same as the community’s', () => {
      // A token repeating the column would be a second number stating no difference.
      expect(deriveClimbRowGrade({ personalLabel: 'V0', communityLabel: 'V0' }).communityGradeToken).toBeNull();
    });

    it('is left out when the column already shows the community grade', () => {
      expect(deriveClimbRowGrade({ personalLabel: null, communityLabel: 'V4' }).communityGradeToken).toBeNull();
    });

    it('is left out when the community has no grade for the climb', () => {
      expect(deriveClimbRowGrade({ personalLabel: 'V7', communityLabel: null }).communityGradeToken).toBeNull();
      expect(deriveClimbRowGrade({ boardseshLabel: 'V5', communityLabel: '' }).communityGradeToken).toBeNull();
    });

    it('leads the detail line when the Boardsesh grade in the column reads differently', () => {
      expect(deriveClimbRowGrade({ boardseshLabel: 'V5', communityLabel: 'V4' })).toEqual({
        source: 'boardsesh',
        label: 'V5',
        markedAsMine: false,
        communityGradeToken: 'V4',
      });
    });

    it('is left out when the Boardsesh grade reads the same as the community’s', () => {
      expect(deriveClimbRowGrade({ boardseshLabel: 'V4', communityLabel: 'V4' }).communityGradeToken).toBeNull();
    });

    it('does not count the estimate mark as a difference', () => {
      // "≈V4" beside "V4" is one number said twice. A different number is still shown.
      expect(deriveClimbRowGrade({ boardseshLabel: '≈V4', communityLabel: 'V4' }).communityGradeToken).toBeNull();
      expect(deriveClimbRowGrade({ boardseshLabel: '≈V5', communityLabel: 'V4' }).communityGradeToken).toBe('V4');
    });

    it('compares against the grade in the column, not the one the climber’s grade replaced', () => {
      // Your V5 agrees with Boardsesh but not with the community: the token shows.
      expect(
        deriveClimbRowGrade({ personalLabel: 'V5', boardseshLabel: 'V5', communityLabel: 'V4' }).communityGradeToken,
      ).toBe('V4');
      // Your V4 disagrees with Boardsesh but agrees with the community: it does not.
      expect(
        deriveClimbRowGrade({ personalLabel: 'V4', boardseshLabel: '≈V5', communityLabel: 'V4' }).communityGradeToken,
      ).toBeNull();
    });

    it('follows the climber’s grade format', () => {
      // The same climb read in Font grades: no scale maths in this module.
      expect(deriveClimbRowGrade({ personalLabel: '7A', communityLabel: '7A' }).communityGradeToken).toBeNull();
      expect(deriveClimbRowGrade({ personalLabel: '7A', communityLabel: '6B' }).communityGradeToken).toBe('6B');
    });

    it('shows only the V half under the both-systems format', () => {
      // The column already reads "V10 / 7C+". Both halves again would take twice
      // the width and could look like a second scale.
      expect(deriveClimbRowGrade({ personalLabel: 'V10 / 7C+', communityLabel: 'V5+ / 6C+' })).toEqual({
        source: 'personal',
        label: 'V10 / 7C+',
        markedAsMine: true,
        communityGradeToken: 'V5+',
      });
      expect(deriveClimbRowGrade({ boardseshLabel: '≈V5 / 6C', communityLabel: 'V4 / 6B' }).communityGradeToken).toBe(
        'V4',
      );
    });

    it('still compares the whole label under the both-systems format', () => {
      expect(
        deriveClimbRowGrade({ personalLabel: 'V5+ / 6C+', communityLabel: 'V5+ / 6C+' }).communityGradeToken,
      ).toBeNull();
      expect(
        deriveClimbRowGrade({ boardseshLabel: '≈V5 / 6C', communityLabel: 'V5 / 6C' }).communityGradeToken,
      ).toBeNull();
    });

    it('is never shown on a climb nobody has graded', () => {
      // A Project: with no grade for the column there is no community grade either.
      expect(deriveClimbRowGrade({}).communityGradeToken).toBeNull();
      expect(deriveClimbRowGrade({ personalLabel: null, boardseshLabel: null, communityLabel: '' })).toEqual({
        source: 'none',
        label: '',
        markedAsMine: false,
        communityGradeToken: null,
      });
    });
  });
});
