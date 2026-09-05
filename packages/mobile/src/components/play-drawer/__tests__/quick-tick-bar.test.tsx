// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// QuickTickBar is the create sheet's field stack and nothing else — the state,
// the save path and the analytics all live in useQuickTickForm (tested next
// door). What is left to pin here is the layout contract: which rows exist, in
// what order, and how each control is wired to the form.

// Hoisted: the `../tick` mock factory below reads it, and vi.mock factories are
// lifted above every top-level binding in the file.
const RAIL_TRAIL_INSET = vi.hoisted(() => 24);

type RowProps = { label: string; children?: ReactNode; bleed?: boolean; height?: number; showSeparator?: boolean };

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// QuickTickBar now renders one helper line under the grade rail (#4796), which
// pulls in StyleSheet and the Text primitive. Neither is what this suite tests,
// and the real react-native module does not transform under it.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: 'secondaryLabel' } }),
}));

// Stub the tick family: each stub records the props it was handed as data
// attributes, so the wiring is readable from the DOM without a native tree.
vi.mock('../../tick', () => ({
  TICK_RAIL_ROW_HEIGHT: 60,
  TICK_RAIL_TRAIL_INSET: RAIL_TRAIL_INSET,
  TickFormRow: ({ label, children, bleed, height, showSeparator }: RowProps) =>
    createElement(
      'div',
      {
        'data-row': label,
        'data-bleed': String(Boolean(bleed)),
        'data-height': height == null ? '' : String(height),
        'data-separator': String(showSeparator !== false),
      },
      createElement('span', { 'data-row-label': label }, label),
      children,
    ),
  TickDateRow: ({
    dateAccessibilityLabel,
    timeAccessibilityLabel,
    onChange,
  }: {
    dateAccessibilityLabel: string;
    timeAccessibilityLabel: string;
    onChange: (next: Date) => void;
  }) =>
    createElement('button', {
      'data-testid': 'tick-date-row',
      'data-date-label': dateAccessibilityLabel,
      'data-time-label': timeAccessibilityLabel,
      onClick: () => onChange(new Date('2025-03-15T12:00:00.000Z')),
    }),
  TickCountRail: ({ value, onSelect }: { value: number; onSelect: (next: number) => void }) =>
    createElement('button', {
      'data-testid': 'tick-count-rail',
      'data-value': String(value),
      onClick: () => onSelect(value + 1),
    }),
  TickNoteField: ({
    value,
    placeholder,
    accessibilityLabel,
  }: {
    value: string;
    placeholder: string;
    accessibilityLabel: string;
  }) =>
    createElement('div', {
      'data-testid': 'tick-note-field',
      'data-value': value,
      'data-placeholder': placeholder,
      'data-aria': accessibilityLabel,
    }),
}));

vi.mock('../../grade', () => ({
  GradeSingleSelectRail: ({
    colorway,
    contentInsetLeft,
    contentInsetRight,
    selectedDifficultyId,
    consensusDifficultyId,
    onSelect,
  }: {
    colorway?: string;
    contentInsetLeft?: number;
    contentInsetRight?: number;
    selectedDifficultyId?: number | null;
    consensusDifficultyId?: number | null;
    onSelect: (difficultyId: number | undefined) => void;
  }) =>
    createElement('button', {
      'data-testid': 'grade-rail',
      'data-colorway': colorway,
      'data-inset-left': String(contentInsetLeft),
      'data-inset-right': String(contentInsetRight),
      'data-selected': String(selectedDifficultyId ?? ''),
      'data-consensus': String(consensusDifficultyId ?? ''),
      onClick: () => onSelect(7),
    }),
}));

// Faithful to the real StarRating's contract: it emits the picked rating, and
// tapping the current one emits its `clearValue`, which defaults to 0.
vi.mock('../../StarRating', () => ({
  StarRating: ({
    value,
    onChange,
    clearValue = 0,
  }: {
    value: number | undefined;
    onChange: (rating: number | undefined) => void;
    clearValue?: number | undefined;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'star-rating', 'data-value': String(value ?? '') },
      createElement('button', { 'data-testid': 'star-pick', onClick: () => onChange(4) }),
      createElement('button', { 'data-testid': 'star-clear', onClick: () => onChange(clearValue) }),
    ),
}));

import { QuickTickBar } from '../QuickTickBar';
import type { QuickTickForm } from '../use-quick-tick-form';

function makeForm(overrides: Partial<QuickTickForm> = {}): QuickTickForm {
  return {
    climbUuid: 'climb-1',
    tickState: { quality: null, difficulty: undefined, attemptCount: 1 },
    comment: '',
    climbedAt: new Date('2025-06-01T08:00:00.000Z'),
    maximumClimbedAtDate: new Date('2025-06-01T08:00:00.000Z'),
    grades: [{ difficultyId: 7, name: 'V5' }] as unknown as QuickTickForm['grades'],
    consensusDifficultyId: 7,
    resolvedGradeName: undefined,
    ascentType: 'send',
    saveLabel: 'playView.tickBar.sendSaveLabel',
    isPending: false,
    lastError: null,
    onQualitySelect: vi.fn(),
    onGradeSelect: vi.fn(),
    onTriesSelect: vi.fn(),
    onCommentChange: vi.fn(),
    onClimbedAtChange: vi.fn(),
    onFutureAdjusted: vi.fn(),
    onSave: vi.fn(),
    onAttempt: vi.fn(),
    ...overrides,
  };
}

function renderBar(overrides: Partial<QuickTickForm> = {}) {
  const form = makeForm(overrides);
  return { form, ...render(createElement(QuickTickBar, { form })) };
}

function rowLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-row-label]')).map(
    (node) => node.getAttribute('data-row-label') ?? '',
  );
}

describe('QuickTickBar row order', () => {
  // Rows run least-used at the top to most-used at the bottom so the controls
  // people actually reach for land in the thumb zone (#4163). The ordering is
  // driven by measured interaction rates — tries 28%, stars 24%, grade 6.5%,
  // note 1.4%, date/time under 1% — so pin it down here rather than let a
  // future edit quietly shuffle it back.
  it('runs date, grade, stars, tries, note from top to bottom', () => {
    const { container } = renderBar();

    expect(rowLabels(container)).toEqual([
      'mobile.tick.dateLabel',
      'mobile.tick.gradeLabel',
      'mobile.tick.starsLabel',
      'mobile.tick.triesLabel',
      'mobile.tick.noteLabel',
    ]);
  });

  it('puts date and time on a single row, both fields committing through one handler', () => {
    const { container, getByTestId, form } = renderBar();

    // The time field has no label row of its own — it rides the date row.
    expect(rowLabels(container)).not.toContain('mobile.tick.timeLabel');
    const dateRow = getByTestId('tick-date-row');
    expect(dateRow.getAttribute('data-date-label')).toBe('mobile.tick.dateLabel');
    expect(dateRow.getAttribute('data-time-label')).toBe('mobile.tick.timeLabel');

    fireEvent.click(dateRow);
    expect(form.onClimbedAtChange).toHaveBeenCalledTimes(1);
  });

  it('closes the form with the note row, which carries no separator below it', () => {
    const { container } = renderBar();

    const noteRow = container.querySelector('[data-row="mobile.tick.noteLabel"]');
    expect(noteRow?.getAttribute('data-separator')).toBe('false');
  });
});

describe('QuickTickBar rail rows', () => {
  // The row owns the gutter; a rail bleeds to the screen edge and supplies only
  // its own trailing inset. Getting this wrong is what produced the ragged left
  // edge the redesign exists to fix.
  it('bleeds the grade rail to the edge and starts it on the control seam', () => {
    const { container, getByTestId } = renderBar();

    const gradeRow = container.querySelector('[data-row="mobile.tick.gradeLabel"]');
    expect(gradeRow?.getAttribute('data-bleed')).toBe('true');
    expect(gradeRow?.getAttribute('data-height')).toBe('60');

    const rail = getByTestId('grade-rail');
    expect(rail.getAttribute('data-colorway')).toBe('selection');
    expect(rail.getAttribute('data-inset-left')).toBe('0');
    expect(rail.getAttribute('data-inset-right')).toBe(String(RAIL_TRAIL_INSET));
  });

  it('bleeds the tries rail too, and wires it to the form count', () => {
    const { container, getByTestId, form } = renderBar({
      tickState: { quality: null, difficulty: undefined, attemptCount: 4 },
    });

    expect(container.querySelector('[data-row="mobile.tick.triesLabel"]')?.getAttribute('data-bleed')).toBe('true');
    const rail = getByTestId('tick-count-rail');
    expect(rail.getAttribute('data-value')).toBe('4');

    fireEvent.click(rail);
    expect(form.onTriesSelect).toHaveBeenCalledWith(5);
  });

  it('hands the grade rail the picked and consensus ids', () => {
    const { getByTestId, form } = renderBar({
      tickState: { quality: null, difficulty: 7, attemptCount: 1 },
      consensusDifficultyId: 9,
    });

    const rail = getByTestId('grade-rail');
    expect(rail.getAttribute('data-selected')).toBe('7');
    expect(rail.getAttribute('data-consensus')).toBe('9');

    fireEvent.click(rail);
    expect(form.onGradeSelect).toHaveBeenCalledWith(7);
  });
});

describe('QuickTickBar stars', () => {
  // StarRating speaks `number | undefined`; the tick state stores `null` for an
  // unset rating, and the save path only treats a positive quality as a rating.
  it('maps a picked star straight through and a cleared one back to null', () => {
    const { getByTestId, form } = renderBar({ tickState: { quality: 3, difficulty: undefined, attemptCount: 1 } });

    expect(getByTestId('star-rating').getAttribute('data-value')).toBe('3');

    fireEvent.click(getByTestId('star-pick'));
    expect(form.onQualitySelect).toHaveBeenCalledWith(4);

    fireEvent.click(getByTestId('star-clear'));
    expect(form.onQualitySelect).toHaveBeenCalledWith(null);
  });
});

describe('QuickTickBar note', () => {
  it('renders the shared note field with the tick catalog copy', () => {
    const { getByTestId } = renderBar({ comment: 'crimpy' });

    const note = getByTestId('tick-note-field');
    expect(note.getAttribute('data-value')).toBe('crimpy');
    expect(note.getAttribute('data-placeholder')).toBe('mobile.tick.notePlaceholder');
    expect(note.getAttribute('data-aria')).toBe('mobile.tick.noteAria');
  });
});
