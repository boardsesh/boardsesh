import { describe, it, expect, vi } from 'vitest';
import { deriveGradeTokenModel, gradeTokenA11yLabel, type GradeTokenModel } from '../grade-token';

/**
 * The rule under test, in one sentence: a glyph on the number means the number
 * is not the one this screen is about. Catalog surfaces (`baseline: 'crowd'`)
 * mark YOUR grade; diary surfaces (`baseline: 'personal'`) mark the CROWD's.
 * Only one number is ever in the column, so the two markers can never co-occur.
 */
describe('deriveGradeTokenModel', () => {
  it('reports nothing to show when neither grade exists', () => {
    expect(deriveGradeTokenModel({ personalLabel: null, crowdLabel: null })).toEqual({
      source: 'none',
      label: '',
      crowdLineToken: null,
      mark: false,
    });
  });

  it('treats an empty label as no label at all', () => {
    // `resolveGrade` hands back '' for a climb whose stats row has no
    // difficulty, and that must read as "no crowd grade", not as a grade.
    expect(deriveGradeTokenModel({ personalLabel: null, crowdLabel: '' }).source).toBe('none');
    expect(deriveGradeTokenModel({ personalLabel: '', crowdLabel: 'V4' }).source).toBe('crowd');
  });

  it('treats an unfetched logbook exactly like a climb you never graded', () => {
    // Callers pass null for both "no grade" and "not known yet" — guessing
    // "no ticks" from an empty bucket is what caused #3940.
    expect(deriveGradeTokenModel({ personalLabel: undefined, crowdLabel: 'V4' })).toEqual({
      source: 'crowd',
      label: 'V4',
      crowdLineToken: null,
      mark: false,
    });
  });

  describe("catalog surfaces (baseline 'crowd')", () => {
    it('shows the crowd grade bare when the climber never graded it', () => {
      // The common case, and the row a climber with no ticks sees everywhere.
      expect(deriveGradeTokenModel({ personalLabel: null, crowdLabel: 'V4', baseline: 'crowd' })).toEqual({
        source: 'crowd',
        label: 'V4',
        crowdLineToken: null,
        mark: false,
      });
    });

    it('shows your grade, marked, with the crowd’s demoted to the meta line', () => {
      // The Woods case in #4796 / #4828: set at V0, you called it V10.
      expect(deriveGradeTokenModel({ personalLabel: 'V10', crowdLabel: 'V0', baseline: 'crowd' })).toEqual({
        source: 'personal',
        label: 'V10',
        crowdLineToken: 'V0',
        mark: true,
      });
    });

    it('MARKS your grade even when it renders to the same label as the crowd’s', () => {
      // The rule change over #5143's first cut, which marked only on
      // disagreement: a glyph that appears and disappears on the same climb as
      // the crowd grade drifts past yours teaches nobody what it means. The
      // marker answers "whose number is this", so it does not depend on what
      // the other number happens to be.
      expect(deriveGradeTokenModel({ personalLabel: 'V4', crowdLabel: 'V4', baseline: 'crowd' })).toEqual({
        source: 'personal',
        label: 'V4',
        // ...and there is still nothing to put on the meta line: a token
        // repeating the column would be a second number stating no difference.
        crowdLineToken: null,
        mark: true,
      });
    });

    it('marks your grade with no meta token when there is no crowd number', () => {
      // A draft, or an angle with no stats row.
      expect(deriveGradeTokenModel({ personalLabel: 'V7', crowdLabel: null, baseline: 'crowd' })).toEqual({
        source: 'personal',
        label: 'V7',
        crowdLineToken: null,
        mark: true,
      });
    });

    it('defaults to the catalog reading when no baseline is given', () => {
      expect(deriveGradeTokenModel({ personalLabel: 'V7', crowdLabel: 'V4' }).mark).toBe(true);
      expect(deriveGradeTokenModel({ personalLabel: null, crowdLabel: 'V4' }).mark).toBe(false);
    });
  });

  describe("diary surfaces (baseline 'personal')", () => {
    it('shows your own grade bare — your diary is about what you did', () => {
      expect(deriveGradeTokenModel({ personalLabel: 'V8', crowdLabel: null, baseline: 'personal' })).toEqual({
        source: 'personal',
        label: 'V8',
        crowdLineToken: null,
        mark: false,
      });
    });

    it('MARKS the crowd’s grade when you never graded the tick', () => {
      // The mirror image of the climbs list: here the crowd's number is the
      // exception, so it is the one that has to say whose it is.
      expect(deriveGradeTokenModel({ personalLabel: null, crowdLabel: 'V9', baseline: 'personal' })).toEqual({
        source: 'crowd',
        label: 'V9',
        crowdLineToken: null,
        mark: true,
      });
    });

    it('keeps your grade unmarked and sends the crowd’s to the meta line on a disagreement', () => {
      expect(deriveGradeTokenModel({ personalLabel: 'V8', crowdLabel: 'V9', baseline: 'personal' })).toEqual({
        source: 'personal',
        label: 'V8',
        crowdLineToken: 'V9',
        mark: false,
      });
    });

    it('never marks both ways at once, whichever baseline is in play', () => {
      // Structural: only ONE number is ever in the column, so `mark` is one
      // boolean about one number and cannot describe two glyphs.
      for (const baseline of ['crowd', 'personal'] as const) {
        const model = deriveGradeTokenModel({ personalLabel: 'V8', crowdLabel: 'V9', baseline });
        expect(model.source === 'personal' || model.source === 'crowd').toBe(true);
      }
    });
  });

  describe('equality is on the rendered label, never the difficulty id', () => {
    it('reads two ids that render alike as one number, with nothing to demote', () => {
      // Aurora's ids 10/11/12 are 4a, 4b and 4c — three distinct grades that
      // all render "V0". A climber who logged 4c on a climb the board lists as
      // 4a has not disagreed with anything a reader can see, so putting "V0"
      // on the meta line beside "V0" in the column would be a second number
      // stating no difference. (The retired `deriveLogbookGradeDisplay`
      // compared ids and got exactly this wrong.)
      expect(deriveGradeTokenModel({ personalLabel: 'V0', crowdLabel: 'V0' }).crowdLineToken).toBeNull();
    });

    it('follows the climber’s grade-format preference for free', () => {
      // Same climb read under Font: agreement and disagreement behave the same
      // way they do under V-grades, with no scale maths in this module.
      expect(deriveGradeTokenModel({ personalLabel: '7A', crowdLabel: '7A' }).crowdLineToken).toBeNull();
      expect(deriveGradeTokenModel({ personalLabel: '7A', crowdLabel: '6B' }).crowdLineToken).toBe('6B');
    });
  });

  describe("the 'both' grade format", () => {
    it('puts only the V half of the crowd’s label on the meta line', () => {
      // The column already reads "V10 / 7C+"; a meta token repeating both
      // halves would be twice the width for no extra information, and the two
      // could look like they were on different scales.
      expect(deriveGradeTokenModel({ personalLabel: 'V10 / 7C+', crowdLabel: 'V5+ / 6C+' })).toEqual({
        source: 'personal',
        label: 'V10 / 7C+',
        crowdLineToken: 'V5+',
        mark: true,
      });
    });

    it('still compares the FULL label, so two identical both-format labels agree', () => {
      expect(deriveGradeTokenModel({ personalLabel: 'V5+ / 6C+', crowdLabel: 'V5+ / 6C+' }).crowdLineToken).toBeNull();
    });
  });
});

describe('gradeTokenA11yLabel', () => {
  const translate = vi.fn((key: string, values: { grade: string }) => `${key}:${values.grade}`);

  it('says nothing when there is no grade', () => {
    const model: GradeTokenModel = { source: 'none', label: '', crowdLineToken: null, mark: false };
    expect(gradeTokenA11yLabel(model, translate)).toBeNull();
  });

  it('reads an unmarked number bare — the surface already says whose it is', () => {
    const model = deriveGradeTokenModel({ personalLabel: null, crowdLabel: 'V4', baseline: 'crowd' });
    expect(gradeTokenA11yLabel(model, translate)).toBe('V4');
  });

  it('names the owner of a marked number, because the glyph is not spoken', () => {
    const yours = deriveGradeTokenModel({ personalLabel: 'V10', crowdLabel: 'V0', baseline: 'crowd' });
    expect(gradeTokenA11yLabel(yours, translate)).toBe('common:mobile.gradeToken.a11yYours:V10');

    const theirs = deriveGradeTokenModel({ personalLabel: null, crowdLabel: 'V9', baseline: 'personal' });
    expect(gradeTokenA11yLabel(theirs, translate)).toBe('common:mobile.gradeToken.a11yCommunity:V9');
  });
});
