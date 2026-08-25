import { describe, it, expect } from 'vitest';
import type { BoardseshGrade } from '@boardsesh/graphql/operations';
import {
  buildBoardseshGradeView,
  buildBoardseshGradeSummary,
  buildCorrection,
  buildTrustBand,
  formatHalfGrades,
  renderDifficulty,
  lacksCrowdGrade,
} from '../boardsesh-grade-utils';

function makeGrade(overrides: Partial<BoardseshGrade> = {}): BoardseshGrade {
  return {
    localGrade: 20,
    universalGrade: 20,
    gradeLow: 20,
    gradeHigh: 20,
    confidence: 'confirmed',
    ascensionistCount: 42,
    modelVersion: 'v1',
    computedAt: '2026-01-01',
    ...overrides,
  };
}

describe('renderDifficulty', () => {
  it('rounds a float to the nearest grade and colours it', () => {
    // 20 = 6c/V5 on the shared scale.
    const rendered = renderDifficulty(20.3, 'v-grade');
    expect(rendered?.label).toBe('V5');
    expect(rendered?.color).toMatch(/^#/);
  });

  it('formats to Font when the preference asks for it', () => {
    expect(renderDifficulty(20, 'font')?.label).toBe('6C');
  });

  it('clamps below and above the scale bounds', () => {
    expect(renderDifficulty(-100, 'v-grade')?.label).toBe('V0'); // clamps to 4a/V0
    expect(renderDifficulty(9999, 'v-grade')?.label).toBe('V16'); // clamps to 8c+/V16
  });
});

describe('lacksCrowdGrade', () => {
  it('matches the no-crowd-grade boards case-insensitively', () => {
    expect(lacksCrowdGrade('moonboard')).toBe(true);
    expect(lacksCrowdGrade('MoonBoard')).toBe(true);
    expect(lacksCrowdGrade('woods')).toBe(true);
    expect(lacksCrowdGrade('Woods')).toBe(true);
    expect(lacksCrowdGrade('kilter')).toBe(false);
    expect(lacksCrowdGrade('tension')).toBe(false);
  });
});

describe('buildBoardseshGradeView', () => {
  it('returns the no-crowd-grade tier without a grade, naming the board', () => {
    // The board name rides along so the section can pick the right body copy.
    expect(buildBoardseshGradeView('moonboard', makeGrade(), 'v-grade')).toEqual({
      kind: 'noCrowdGrade',
      boardName: 'moonboard',
    });
    expect(buildBoardseshGradeView('Woods', makeGrade(), 'v-grade')).toEqual({
      kind: 'noCrowdGrade',
      boardName: 'woods',
    });
  });

  it('falls back to setter-only (no grade) when there is no grade row', () => {
    expect(buildBoardseshGradeView('kilter', null, 'v-grade')).toEqual({ kind: 'setterOnly', grade: null, count: 0 });
  });

  it('carries the setter grade + count for setter_only confidence', () => {
    const view = buildBoardseshGradeView(
      'kilter',
      makeGrade({ confidence: 'setter_only', ascensionistCount: 2 }),
      'v-grade',
    );
    expect(view.kind).toBe('setterOnly');
    if (view.kind === 'setterOnly') {
      expect(view.grade?.label).toBe('V5');
      expect(view.count).toBe(2);
    }
  });

  it('returns setter-only with a null grade when both grade values are null', () => {
    const view = buildBoardseshGradeView(
      'kilter',
      makeGrade({ confidence: 'confirmed', universalGrade: null, localGrade: null }),
      'v-grade',
    );
    expect(view).toMatchObject({ kind: 'setterOnly', grade: null });
  });

  it('shows a confirmed cross-board grade with the send count and raw value', () => {
    const view = buildBoardseshGradeView('kilter', makeGrade({ universalGrade: 22, ascensionistCount: 7 }), 'v-grade');
    expect(view).toMatchObject({ kind: 'confirmed', universal: true, count: 7, gradeValue: 22 });
    if (view.kind === 'confirmed') expect(view.grade.label).toBe('V6'); // 22 = 7a/V6
  });

  it('marks the grade local-only when there is no universal grade', () => {
    const view = buildBoardseshGradeView('kilter', makeGrade({ universalGrade: null, localGrade: 20 }), 'v-grade');
    expect(view).toMatchObject({ kind: 'confirmed', universal: false, gradeValue: 20 });
  });

  it('shows a provisional range when the bounds round to different grades', () => {
    const view = buildBoardseshGradeView(
      'kilter',
      makeGrade({ confidence: 'provisional', universalGrade: 20, gradeLow: 20, gradeHigh: 22 }),
      'v-grade',
    );
    expect(view).toMatchObject({ kind: 'provisional', universal: true, rangeLabel: 'V5–V6' });
  });

  it('shows a provisional single grade (no range) when the bounds round together', () => {
    const view = buildBoardseshGradeView(
      'kilter',
      makeGrade({ confidence: 'provisional', universalGrade: 20, gradeLow: 20, gradeHigh: 20.4 }),
      'v-grade',
    );
    expect(view).toMatchObject({ kind: 'provisional', rangeLabel: null });
    if (view.kind === 'provisional') expect(view.grade.label).toBe('V5');
  });

  it('treats an unknown confidence value as provisional', () => {
    const view = buildBoardseshGradeView(
      'kilter',
      makeGrade({ confidence: 'something-new', gradeLow: null, gradeHigh: null }),
      'v-grade',
    );
    expect(view.kind).toBe('provisional');
  });

  it('passes computedAt through unchanged for confirmed and provisional tiers', () => {
    const confirmed = buildBoardseshGradeView('kilter', makeGrade({ computedAt: '2026-03-15T00:00:00Z' }), 'v-grade');
    expect(confirmed).toMatchObject({ kind: 'confirmed', computedAt: '2026-03-15T00:00:00Z' });

    const provisional = buildBoardseshGradeView(
      'kilter',
      makeGrade({ confidence: 'provisional', computedAt: '2026-03-16T00:00:00Z' }),
      'v-grade',
    );
    expect(provisional).toMatchObject({ kind: 'provisional', computedAt: '2026-03-16T00:00:00Z' });
  });
});

describe('formatHalfGrades', () => {
  it('renders ½-step magnitudes compactly', () => {
    expect(formatHalfGrades(0)).toBeNull();
    expect(formatHalfGrades(0.5)).toBe('½');
    expect(formatHalfGrades(1)).toBe('1');
    expect(formatHalfGrades(1.5)).toBe('1½');
    expect(formatHalfGrades(2)).toBe('2');
  });
});

describe('buildCorrection', () => {
  it('returns null when there is no crowd grade at this angle', () => {
    expect(buildCorrection(null, 20, 'v-grade')).toBeNull();
  });

  it('reads a stiffer crowd as "everywhere is easier"', () => {
    // Crowd 22 (V6) vs cross-board 20 (V5): the crowd over-grades by one V-grade
    // (two id steps), so everywhere it climbs a full grade easier.
    const correction = buildCorrection(22, 20, 'v-grade');
    expect(correction).toMatchObject({ direction: 'easier', steps: 1, label: '1' });
    expect(correction?.crowd.label).toBe('V6');
  });

  it('reads a softer crowd as "everywhere is stiffer"', () => {
    const correction = buildCorrection(20, 22, 'v-grade');
    expect(correction).toMatchObject({ direction: 'stiffer', steps: 1, label: '1' });
  });

  it('rounds a one-id gap that crosses a grade boundary to half a grade', () => {
    // Crowd 22 (V6) vs cross-board 21 (V5): one Font step apart, and — crucially —
    // the rendered labels differ, so it surfaces as a ½-grade correction.
    const correction = buildCorrection(22, 21, 'v-grade');
    expect(correction).toMatchObject({ direction: 'easier', steps: 0.5, label: '½' });
    expect(correction?.crowd.label).toBe('V6');
  });

  it('reads a genuine one-V difference as a full-grade correction', () => {
    // Crowd 18 (V4) vs cross-board 16 (V3): two id steps, labels differ.
    const correction = buildCorrection(18, 16, 'v-grade');
    expect(correction).toMatchObject({ direction: 'easier', steps: 1, label: '1' });
    expect(correction?.crowd.label).toBe('V4');
  });

  it('reports equal when both round to the same grade bucket', () => {
    const correction = buildCorrection(20.3, 20, 'v-grade');
    expect(correction).toMatchObject({ direction: 'equal', steps: 0, label: null });
  });

  it('agrees (no pill, no payoff) when two different ids render the same V-grade label', () => {
    // V1 covers ids 13 (5a) and 14 (5b) — neither Font grade takes a "+", so both
    // render exactly "V1". The crowd rounds V1 from id 14, the Boardsesh grade V1
    // from id 13; the hero shows "V1" on both sides, so the one-id gap must NOT
    // surface as a correction — the displayed label, not the id delta, decides.
    const correction = buildCorrection(14, 13, 'v-grade');
    expect(correction).toMatchObject({ direction: 'equal', steps: 0, label: null });
    expect(correction?.crowd.label).toBe('V1');
  });

  it('surfaces the same ids as a correction under font format, where the labels differ', () => {
    // Same ids, but font format renders 5B vs 5A — different labels — so at font
    // resolution it IS a ½-grade correction. Agreement follows what the viewer sees.
    const correction = buildCorrection(14, 13, 'font');
    expect(correction).toMatchObject({ direction: 'easier', steps: 0.5, label: '½' });
  });

  it('gates agreement the same way the collapsed teaser does', () => {
    // crowd id 14 and Boardsesh id 13 both render V1: the correction reads equal
    // AND the teaser drops its "▸" arrow, so hero and teaser stay in lockstep.
    expect(buildCorrection(14, 13, 'v-grade')?.direction).toBe('equal');
    const view = buildBoardseshGradeView('kilter', makeGrade({ universalGrade: 13 }), 'v-grade');
    expect(buildBoardseshGradeSummary(view, { crowdLabel: 'V1' })).toBe('V1 ✓');
  });
});

describe('buildTrustBand', () => {
  it('reports a real range when the bounds render different labels', () => {
    // 18 = 6b/V4, 22 = 7a/V6.
    expect(buildTrustBand(18, 22, 'V5', 'v-grade')).toEqual({ low: 'V4', high: 'V6', sameLabel: false });
  });

  it('collapses to a single grade when two different ids render the SAME label', () => {
    // 10 (4a) and 12 (4c) are different ids that both render "V0" — a "V0–V0"
    // range reads as a bug (this is the "V4+–V4+" the review flagged), so
    // sameLabel is true and the caller shows one grade.
    expect(buildTrustBand(10, 12, 'V0', 'v-grade')).toEqual({ low: 'V0', high: 'V0', sameLabel: true });
  });

  it('collapses to a single grade when both bounds are the same id', () => {
    expect(buildTrustBand(20, 20, 'V5', 'v-grade')).toEqual({ low: 'V5', high: 'V5', sameLabel: true });
  });

  it('keeps a half-grade range when the labels differ by a "+" step', () => {
    // 20 = 6c/V5 renders "V5"; 21 = 6c+/V5 renders "V5+" — a real range.
    expect(buildTrustBand(20, 21, 'V5', 'v-grade')).toEqual({ low: 'V5', high: 'V5+', sameLabel: false });
  });

  it('falls back to the headline label when a bound is missing', () => {
    expect(buildTrustBand(null, null, 'V7', 'v-grade')).toEqual({ low: 'V7', high: 'V7', sameLabel: true });
  });
});

describe('buildBoardseshGradeSummary', () => {
  it('leads with the correction when a differing crowd label is supplied', () => {
    const view = buildBoardseshGradeView('kilter', makeGrade({ universalGrade: 20 }), 'v-grade');
    expect(buildBoardseshGradeSummary(view, { crowdLabel: 'V6' })).toBe('V6 ▸ V5 ✓');
  });

  it('shows just the confirmed grade with a check when there is no crowd label', () => {
    const view = buildBoardseshGradeView('kilter', makeGrade({ universalGrade: 20 }), 'v-grade');
    expect(buildBoardseshGradeSummary(view)).toBe('V5 ✓');
  });

  it('drops the arrow when the crowd label matches the cross-board grade', () => {
    const view = buildBoardseshGradeView('kilter', makeGrade({ universalGrade: 20 }), 'v-grade');
    expect(buildBoardseshGradeSummary(view, { crowdLabel: 'V5' })).toBe('V5 ✓');
  });

  it('marks a local-only grade with the local word', () => {
    const view = buildBoardseshGradeView('kilter', makeGrade({ universalGrade: null, localGrade: 20 }), 'v-grade');
    expect(buildBoardseshGradeSummary(view, { localWord: 'local' })).toBe('V5 · local');
  });

  it('shows the bare local grade when no local word is supplied', () => {
    const view = buildBoardseshGradeView('kilter', makeGrade({ universalGrade: null, localGrade: 20 }), 'v-grade');
    expect(buildBoardseshGradeSummary(view)).toBe('V5');
  });

  it('marks a provisional grade with a tilde', () => {
    const view = buildBoardseshGradeView(
      'kilter',
      makeGrade({ confidence: 'provisional', universalGrade: 20, gradeLow: 20, gradeHigh: 20.4 }),
      'v-grade',
    );
    expect(buildBoardseshGradeSummary(view)).toBe('V5 ~');
  });

  it('uses the range for a provisional grade spanning two grades', () => {
    const view = buildBoardseshGradeView(
      'kilter',
      makeGrade({ confidence: 'provisional', universalGrade: 20, gradeLow: 20, gradeHigh: 22 }),
      'v-grade',
    );
    expect(buildBoardseshGradeSummary(view)).toBe('V5–V6 ~');
  });

  it('returns null for no-crowd-grade and setter-only tiers', () => {
    expect(buildBoardseshGradeSummary({ kind: 'noCrowdGrade', boardName: 'moonboard' })).toBeNull();
    expect(buildBoardseshGradeSummary({ kind: 'noCrowdGrade', boardName: 'woods' })).toBeNull();
    expect(buildBoardseshGradeSummary({ kind: 'setterOnly', grade: null, count: 0 })).toBeNull();
  });
});
