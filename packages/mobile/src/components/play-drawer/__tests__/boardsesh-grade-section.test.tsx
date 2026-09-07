// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardseshGrade, BoardseshGradeAtAngle, ClimbStatsHistoryEntry } from '@boardsesh/graphql/operations';

const hookState = vi.hoisted(() => ({
  grade: undefined as BoardseshGrade | undefined,
  angleRows: undefined as BoardseshGradeAtAngle[] | undefined,
  history: undefined as ClimbStatsHistoryEntry[] | undefined,
}));

// The climber's own grade for the rendered climb. 'unknown' (the pre-fetch
// state) renders nothing at all, so the existing hero/trust/chart cases below
// stay tests of the crowd path alone.
const myGradeOverride = vi.hoisted(() => ({
  current: { status: 'unknown' } as
    | { status: 'unknown' }
    | { status: 'none' }
    | { status: 'set'; difficultyId: number; climbedAt: string },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../DumbbellByAngleChart', () => ({
  DumbbellByAngleChart: () => createElement('div', { 'data-testid': 'dumbbell' }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#6D28D9' } }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v-grade' }) }));
vi.mock('../../../hooks/use-my-grade', () => ({ useMyGrade: () => myGradeOverride.current }));

vi.mock('../../../lib/graphql/hooks', () => ({
  useBoardseshGrade: () => ({ data: hookState.grade, isLoading: false, isError: false, refetch: vi.fn() }),
  useBoardseshGradesForAngles: () => ({ data: hookState.angleRows }),
  useClimbStatsHistory: () => ({ data: hookState.history }),
}));

import { BoardseshGradeSection } from '../BoardseshGradeSection';

function grade(overrides: Partial<BoardseshGrade> = {}): BoardseshGrade {
  return {
    localGrade: 20,
    universalGrade: 20,
    gradeLow: 19,
    gradeHigh: 21,
    confidence: 'confirmed',
    ascensionistCount: 205,
    modelVersion: 'v1',
    computedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function historyEntry(angle: number, displayDifficulty: number, sends: number): ClimbStatsHistoryEntry {
  return {
    angle,
    displayDifficulty,
    difficultyAverage: displayDifficulty,
    ascensionistCount: sends,
    qualityAverage: 3,
    createdAt: '2026-01-01T00:00:00Z',
  } as ClimbStatsHistoryEntry;
}

function angleRow(
  angle: number,
  universalGrade: number | null,
  overrides: Partial<BoardseshGradeAtAngle> = {},
): BoardseshGradeAtAngle {
  return {
    angle,
    localGrade: 20,
    universalGrade,
    gradeLow: 19,
    gradeHigh: 21,
    confidence: 'confirmed',
    ascensionistCount: 100,
    modelVersion: 'v1',
    computedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderSection(boardName = 'kilter') {
  return render(<BoardseshGradeSection climbUuid="climb-1" boardName={boardName} angle={40} />);
}

describe('BoardseshGradeSection', () => {
  beforeEach(() => {
    hookState.grade = undefined;
    hookState.angleRows = undefined;
    hookState.history = undefined;
    myGradeOverride.current = { status: 'unknown' };
  });

  it('leads with the correction: this-board crowd → arrow → all-boards grade + seal + trust + chart', () => {
    // Crowd calls it V6 (22) at 40°; cross-board grade is V5 (20) — across all boards it's a grade easier.
    hookState.grade = grade({ universalGrade: 20 });
    hookState.history = [historyEntry(40, 22, 205), historyEntry(20, 21, 50)];
    hookState.angleRows = [angleRow(40, 20), angleRow(20, 19)];

    const { container } = renderSection();
    const text = container.textContent ?? '';

    expect(text).toContain('boardseshGrade.hero.thisBoard');
    expect(text).toContain('boardseshGrade.hero.everywhere');
    // The delta now reads only from the arrow + the single payoff sentence — no pill.
    expect(container.querySelector('[data-icon="arrow.right"]')).not.toBeNull();
    expect(text).toContain('boardseshGrade.payoff.softer');
    // gradeLow 19 (V4) / gradeHigh 21 (V5) round apart → the ranged trust line.
    expect(text).toContain('boardseshGrade.trust.confirmedRange');
    expect(container.querySelector('[data-icon="checkmark.seal.fill"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="dumbbell"]')).not.toBeNull();
  });

  it('collapses the confirmed trust line to a single grade when both bounds round together', () => {
    // gradeLow 20 and gradeHigh 20 both render V5 — no real range, so no "V5–V5".
    hookState.grade = grade({ universalGrade: 20, gradeLow: 20, gradeHigh: 20 });
    hookState.history = [historyEntry(40, 22, 205)];
    hookState.angleRows = [angleRow(40, 20)];

    const { container } = renderSection();
    const text = container.textContent ?? '';

    expect(text).toContain('boardseshGrade.trust.confirmedSingle');
    expect(text).not.toContain('boardseshGrade.trust.confirmedRange');
  });

  it('renders provisional in the amber, no-seal path with the likely range', () => {
    hookState.grade = grade({ confidence: 'provisional', universalGrade: 20, gradeLow: 20, gradeHigh: 22 });
    hookState.history = [historyEntry(40, 22, 8)];
    hookState.angleRows = [angleRow(40, 20, { confidence: 'provisional' })];

    const { container } = renderSection();
    const text = container.textContent ?? '';

    expect(text).toContain('boardseshGrade.trust.provisionalRange');
    expect(text).toContain('V5–V6'); // the two-grade range shown as the all-boards grade
    expect(container.querySelector('[data-icon="checkmark.seal.fill"]')).toBeNull();
    expect(text).not.toContain('boardseshGrade.trust.confirmedRange');
  });

  it('shows a muted setter call with no comparison or chart for setter_only', () => {
    hookState.grade = grade({ confidence: 'setter_only', ascensionistCount: 2 });
    hookState.history = [historyEntry(40, 22, 2)];
    hookState.angleRows = [angleRow(40, 20), angleRow(20, 19)];

    const { container } = renderSection();
    const text = container.textContent ?? '';

    expect(text).toContain('boardseshGrade.setterCall');
    expect(text).toContain('boardseshGrade.trust.setter');
    expect(text).not.toContain('boardseshGrade.hero.thisBoard');
    expect(container.querySelector('[data-testid="dumbbell"]')).toBeNull();
  });

  it('shows a single centred grade + note for a local-only (no cross-board) grade', () => {
    hookState.grade = grade({ universalGrade: null, localGrade: 20 });
    hookState.history = [historyEntry(40, 22, 205)];
    hookState.angleRows = [angleRow(40, null), angleRow(20, null)];

    const { container } = renderSection();
    const text = container.textContent ?? '';

    expect(text).toContain('boardseshGrade.hero.thisBoardOnly');
    expect(text).toContain('boardseshGrade.localOnlyNote');
    // No correction: no arrow, no payoff sentence.
    expect(container.querySelector('[data-icon="arrow.right"]')).toBeNull();
    expect(text).not.toContain('boardseshGrade.payoff');
  });

  it('drops the comparison and says it matches when the crowd rounds to the same grade', () => {
    hookState.grade = grade({ universalGrade: 20 });
    hookState.history = [historyEntry(40, 20, 205)]; // crowd V5 == cross-board V5
    hookState.angleRows = [angleRow(40, 20)];

    const { container } = renderSection();
    const text = container.textContent ?? '';

    expect(text).toContain('boardseshGrade.matchesBoard');
    // The "matches this board" note is the single "same" line — no arrow, no payoff row.
    expect(container.querySelector('[data-icon="arrow.right"]')).toBeNull();
    expect(text).not.toContain('boardseshGrade.payoff');
  });
});

// #4796 / #4828 were both filed from the Woods board, where this section is the
// only place a grade is explained — and until now it said nothing but "no
// community data yet".
describe('BoardseshGradeSection personal grade', () => {
  beforeEach(() => {
    hookState.grade = undefined;
    hookState.angleRows = undefined;
    hookState.history = undefined;
    myGradeOverride.current = { status: 'unknown' };
  });

  it('shows your grade above the no-community-data line on Woods', () => {
    myGradeOverride.current = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' };

    const { container } = renderSection('woods');
    const text = container.textContent ?? '';

    expect(text).toContain('boardseshGrade.yours.label');
    expect(text).toContain('V10');
    // The existing explanation is kept, not replaced.
    expect(text).toContain('boardseshGrade.woodsBody');
    expect(container.querySelector('[data-icon="person"]')).not.toBeNull();
  });

  it('offers the grade-it prompt on Woods when you have not graded it', () => {
    // The teaching surface, and the direct answer to #4796's real complaint:
    // nothing anywhere told them the tick form's grade field was the lever.
    myGradeOverride.current = { status: 'none' };

    const { container } = renderSection('woods');
    const text = container.textContent ?? '';

    expect(text).toContain('boardseshGrade.yours.emptyBody');
    expect(text).toContain('boardseshGrade.woodsBody');
  });

  it('says nothing at all while the logbook is still unknown', () => {
    // Never invite someone to grade a climb they may already have graded.
    const { container } = renderSection('woods');
    const text = container.textContent ?? '';

    expect(text).not.toContain('boardseshGrade.yours.emptyBody');
    expect(text).not.toContain('boardseshGrade.yours.label');
    expect(text).toContain('boardseshGrade.woodsBody');
  });

  it('puts your grade above the crowd hero on a board that has community data', () => {
    hookState.grade = grade({ universalGrade: 20 });
    hookState.history = [historyEntry(40, 22, 205)];
    myGradeOverride.current = { status: 'set', difficultyId: 27, climbedAt: '2026-08-01T00:00:00.000Z' };

    const { container } = renderSection();
    const text = container.textContent ?? '';

    expect(text).toContain('boardseshGrade.yours.label');
    expect(text).toContain('boardseshGrade.yours.community');
    // The shipped hero is untouched below it.
    expect(text).toContain('boardseshGrade.hero.everywhere');
  });
});
