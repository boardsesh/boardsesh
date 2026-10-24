// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// react-native isn't satisfiable under jsdom; stub the surface the header touches.
// See play-drawer-header-copy-name.test.tsx for the same pattern.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
  },
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  // The header reads fontScale to decide whether the crowd's second grade line
  // fits (#4796); default Dynamic Type here.
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  Pressable: ({
    children,
    onLongPress,
    disabled,
  }: {
    children?: ReactNode;
    onLongPress?: () => void;
    disabled?: boolean;
  }) => createElement('button', { onClick: () => onLongPress?.(), disabled }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('react-i18next', () => ({
  // Real-enough interpolation so the test can assert the marker carries the
  // STATS angle, not the browsed one, without asserting against the raw key.
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'angle' in options ? `${key}:${String(options.angle)}` : key,
  }),
}));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#000000',
}));
vi.mock('../../../lib/format-climb-stats', () => ({
  formatSends: (count: number) => `${count} sends`,
  formatQuality: (value: string) => value,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: { secondaryLabel: 'secondaryLabel' } }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, variant, color }: { children?: ReactNode; variant?: string; color?: string }) =>
    createElement('span', { 'data-variant': variant, 'data-color': color }, children),
}));
vi.mock('../../MarqueeText', () => ({
  MarqueeText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../DrawerHeader', () => ({
  // Render both slots so the trailing grade column (where the marker lives) is
  // in the tree.
  DrawerHeader: ({ center, trailing }: { center?: ReactNode; trailing?: ReactNode }) =>
    createElement('div', null, center, trailing),
}));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => createElement('i', null) }));

// The real chip reads the theme provider, which this suite does not stand up.
vi.mock('../../DraftChip', () => ({ DraftChip: () => createElement('i', { 'data-chip': 'draft' }) }));
vi.mock('../../ProjectChip', () => ({ ProjectChip: () => createElement('i', { 'data-chip': 'project' }) }));

import { PlayDrawerHeader } from '../PlayDrawerHeader';

const baseProps = {
  name: 'Hueco Madness',
  difficulty: 'V6',
  qualityAverage: '0',
  ascensionistCount: 0,
  setterUsername: '',
};

const marker = (container: HTMLElement) => container.querySelector('[data-variant="caption2"]');

describe('PlayDrawerHeader set-angle marker', () => {
  // #5532: the play drawer showed the set-angle grade and sends with nothing
  // saying they came from a different angle than the one on the wall.
  it('shows "set at N°" under the grade when statsAngle differs from the browsed angle', () => {
    const { container } = render(createElement(PlayDrawerHeader, { ...baseProps, statsAngle: 45, angle: 40 }));
    expect(marker(container)?.textContent).toBe('mobile.climbRow.setAngleMarker:45');
  });

  it('reads the set-angle marker and the subtitle in secondaryLabel', () => {
    const { container } = render(createElement(PlayDrawerHeader, { ...baseProps, statsAngle: 45, angle: 40 }));
    expect(marker(container)?.getAttribute('data-color')).toBe('secondaryLabel');
    expect(container.querySelector('[data-variant="caption1"]')?.getAttribute('data-color')).toBe('secondaryLabel');
  });

  it('shows nothing when statsAngle matches the browsed angle', () => {
    const { container } = render(createElement(PlayDrawerHeader, { ...baseProps, statsAngle: 40, angle: 40 }));
    expect(marker(container)).toBeNull();
  });

  it('shows nothing when statsAngle is null (no cross-angle stats)', () => {
    const { container } = render(createElement(PlayDrawerHeader, { ...baseProps, statsAngle: null, angle: 40 }));
    expect(marker(container)).toBeNull();
  });

  it('shows nothing when statsAngle is omitted entirely', () => {
    const { container } = render(createElement(PlayDrawerHeader, { ...baseProps, angle: 40 }));
    expect(marker(container)).toBeNull();
  });
});

describe('PlayDrawerHeader workout stage subtitle', () => {
  // #5379: a climb from the generated workout says where it sits, first, so a
  // long setter name truncates instead of the position.
  it('leads the subtitle with the workout position', () => {
    const { container } = render(
      createElement(PlayDrawerHeader, {
        ...baseProps,
        ascensionistCount: 12,
        workoutStageLabel: 'Warm-up · 2 of 5',
      }),
    );
    expect(container.querySelector('[data-variant="caption1"]')?.textContent).toBe('Warm-up · 2 of 5 · 12 sends');
  });

  it('leaves the subtitle alone for a climb outside the workout', () => {
    const { container } = render(
      createElement(PlayDrawerHeader, { ...baseProps, ascensionistCount: 12, workoutStageLabel: null }),
    );
    expect(container.querySelector('[data-variant="caption1"]')?.textContent).toBe('12 sends');
  });
});

describe('PlayDrawerHeader stats line', () => {
  const subtitle = (container: HTMLElement) => container.querySelector('[data-variant="caption1"]')?.textContent;

  // #6664 put the list the player walks at the front of this line, and on a
  // phone the sends and stars at its tail were cut off. The list now lives in
  // the top bar, so this line is the climb's own facts.
  it('prints the sends and stars first', () => {
    const { container } = render(
      createElement(PlayDrawerHeader, {
        ...baseProps,
        ascensionistCount: 12,
        qualityAverage: '3.2',
      }),
    );
    expect(subtitle(container)).toBe('12 sends · 3.2★');
  });

  // The workout stage leads so truncation never hides it (#5379).
  it('puts a workout position ahead of the stats', () => {
    const { container } = render(
      createElement(PlayDrawerHeader, {
        ...baseProps,
        ascensionistCount: 12,
        workoutStageLabel: 'Warm-up · 2 of 5',
      }),
    );
    expect(subtitle(container)).toBe('Warm-up · 2 of 5 · 12 sends');
  });

  it('keeps the stats line when there is nothing to print on it', () => {
    // An empty line can measure shorter than a full one, which would step the
    // board between a climb with stats and one without.
    const { container } = render(createElement(PlayDrawerHeader, baseProps));
    expect(subtitle(container)).toBe('​');
  });
});
