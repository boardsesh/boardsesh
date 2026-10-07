// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// #5954: a Save tap with no grade scrolls the drawer to this row. The subtitle
// is what says why — it turns to the warning colour and pulses.

const motion = vi.hoisted(() => ({ reduce: false, sequences: 0 }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => motion.reduce,
  withTiming: (toValue: number) => toValue,
  withSequence: (...steps: number[]) => {
    motion.sequences += 1;
    return steps.at(-1);
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children, color, testID }: { children?: ReactNode; color?: string; testID?: string }) =>
    createElement('span', { 'data-color': color, 'data-testid': testID }, children),
}));
vi.mock('../../grade', () => ({ GradeSingleSelectRail: () => createElement('div', { 'data-node': 'rail' }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useGrades: () => ({ data: [{ difficultyId: 20, name: '6c/V5' }] }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (name: string) => name }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#5B5563' }, brandColors: { warning: '#B45309' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16, 6: 24 } }));

import { SetterGradeRow } from '../SetterGradeRow';

type RowProps = Parameters<typeof SetterGradeRow>[0];
const baseProps: RowProps = { boardName: 'spray', difficultyId: null, onSelect: vi.fn(), required: true };

const rowElement = (overrides: Partial<RowProps> = {}) => createElement(SetterGradeRow, { ...baseProps, ...overrides });
const subtitle = (container: HTMLElement) =>
  container.querySelector('[data-testid="setter-grade-subtitle"]') as HTMLElement;

describe('SetterGradeRow grade prompt', () => {
  beforeEach(() => {
    motion.reduce = false;
    motion.sequences = 0;
  });

  it('reads as a quiet note until Save has asked for the grade', () => {
    const { container } = render(rowElement());
    expect(subtitle(container).textContent).toBe('mobile.create.grade.required');
    expect(subtitle(container).getAttribute('data-color')).toBe('#5B5563');
    expect(motion.sequences).toBe(0);
  });

  it('turns to the warning colour and pulses once Save asks', () => {
    const { container } = render(rowElement({ highlightSignal: 1 }));
    expect(subtitle(container).getAttribute('data-color')).toBe('#B45309');
    expect(motion.sequences).toBe(1);
  });

  it('pulses again on every further tap', () => {
    const { rerender } = render(rowElement({ highlightSignal: 1 }));
    rerender(rowElement({ highlightSignal: 2 }));
    expect(motion.sequences).toBe(2);
  });

  it('keeps the colour and drops the movement under Reduce Motion', () => {
    motion.reduce = true;
    const { container } = render(rowElement({ highlightSignal: 1 }));
    expect(subtitle(container).getAttribute('data-color')).toBe('#B45309');
    expect(motion.sequences).toBe(0);
  });

  it('goes quiet again once a grade is picked', () => {
    const { container } = render(rowElement({ highlightSignal: 1, difficultyId: 20, required: false }));
    expect(subtitle(container).textContent).toBe('6c/V5');
    expect(subtitle(container).getAttribute('data-color')).toBe('#5B5563');
  });

  it('does not warn on a draft, where the grade is optional', () => {
    const { container } = render(rowElement({ highlightSignal: 1, required: false }));
    expect(subtitle(container).textContent).toBe('mobile.create.grade.optional');
    expect(subtitle(container).getAttribute('data-color')).toBe('#5B5563');
  });
});
