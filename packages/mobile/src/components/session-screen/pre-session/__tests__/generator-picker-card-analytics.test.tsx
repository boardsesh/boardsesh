// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratorSelection } from '../GeneratorPickerCard';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));

// The workout-type chips render in CHIP_VALUES order: off, volume, pyramid,
// ladder, gradeFocus. Each Pressable's onPress lands here in render order so the
// test can tap a specific chip.
const chips = vi.hoisted(() => ({ onPress: [] as Array<() => void> }));

vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Pressable: ({ onPress, children }: { onPress?: () => void; children?: ReactNode }) => {
    if (onPress) chips.onPress.push(onPress);
    return createElement('button', null, children);
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-config', () => ({
  // Two grades so getDefaultTargetGrade picks the middle one deterministically.
  getGradesForBoard: () => [
    { difficulty_id: 10, difficulty_name: '5a' },
    { difficulty_id: 20, difficulty_name: '6a' },
  ],
}));
vi.mock('@boardsesh/playlist-generator', () => ({
  DEFAULT_GRADE_FOCUS_OPTIONS: { type: 'gradeFocus' },
  DEFAULT_LADDER_OPTIONS: { type: 'ladder' },
  DEFAULT_PYRAMID_OPTIONS: { type: 'pyramid' },
  DEFAULT_VOLUME_OPTIONS: { type: 'volume' },
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (name: string) => name }),
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../../theme/colors', () => ({ brandColors: {} }));
vi.mock('../../../../theme/ios-colors', () => ({ iosSystemColors: {} }));

import { GeneratorPickerCard } from '../GeneratorPickerCard';

beforeEach(() => {
  analytics.track.mockClear();
  chips.onPress = [];
});

describe('GeneratorPickerCard analytics', () => {
  it('fires "Workout Generator Opened" with web-aligned targetType + angle when switching off → a workout type', () => {
    render(
      createElement(GeneratorPickerCard, {
        boardName: 'kilter',
        angle: 40,
        selection: { type: 'off' } satisfies GeneratorSelection,
        onChange: vi.fn(),
      }),
    );

    // Chip index 1 is 'volume' (index 0 is 'off').
    chips.onPress[1]?.();

    // Exact payload web sends (playlist-generator-drawer.tsx): { targetType, boardName, angle }.
    // No `workoutType` key — PostHog groups by exact prop name, so it must match web.
    expect(analytics.track).toHaveBeenCalledWith('Workout Generator Opened', {
      targetType: 'session',
      boardName: 'kilter',
      angle: 40,
    });
  });

  it('does not fire when tapping "off" (no off → on transition)', () => {
    render(
      createElement(GeneratorPickerCard, {
        boardName: 'kilter',
        angle: 40,
        selection: { type: 'off' } satisfies GeneratorSelection,
        onChange: vi.fn(),
      }),
    );

    chips.onPress[0]?.();

    expect(analytics.track).not.toHaveBeenCalled();
  });
});
