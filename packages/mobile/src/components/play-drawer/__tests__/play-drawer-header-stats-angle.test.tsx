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
