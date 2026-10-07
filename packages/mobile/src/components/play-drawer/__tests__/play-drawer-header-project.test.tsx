// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// react-native isn't satisfiable under jsdom; stub the surface the header touches.
// See play-drawer-header-copy-name.test.tsx for the same pattern.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
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
vi.mock('../../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant }, children),
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
  name: 'Garage project',
  boardName: 'spray' as const,
  qualityAverage: '0',
  ascensionistCount: 0,
  setterUsername: '',
};

const chip = (container: HTMLElement) => container.querySelector('[data-chip="project"]');

describe('PlayDrawerHeader project chip (#5971)', () => {
  it('shows Project in the grade slot for a published climb with no grade', () => {
    const { container } = render(createElement(PlayDrawerHeader, { ...baseProps, difficulty: '' }));
    expect(chip(container)).not.toBeNull();
  });

  it('shows the grade, not the chip, once the climb has one', () => {
    const { container } = render(createElement(PlayDrawerHeader, { ...baseProps, difficulty: 'V4' }));
    expect(chip(container)).toBeNull();
    expect(container.textContent).toContain('V4');
  });

  it('leaves a Kilter climb with no stats yet blank, not a project', () => {
    const { container } = render(
      createElement(PlayDrawerHeader, { ...baseProps, boardName: 'kilter', difficulty: '', statsAngle: null }),
    );
    expect(chip(container)).toBeNull();
  });

  it('leaves an ungraded draft to its Draft chip', () => {
    const { container } = render(createElement(PlayDrawerHeader, { ...baseProps, difficulty: '', isDraft: true }));
    expect(chip(container)).toBeNull();
  });
});
