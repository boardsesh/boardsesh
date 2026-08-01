// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const statusByClimbAngle = vi.hoisted(() => new Map<string, 'flash' | 'send' | 'attempt'>());
const climbAngleKey = (climbUuid: string, angle: number) => `${climbUuid}:${angle}`;

vi.mock('react-native', () => ({
  View: ({
    children,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) => createElement('div', { 'aria-label': accessibilityLabel, role: accessibilityRole }, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#000000',
}));
vi.mock('../../../lib/format-climb-stats', () => ({
  formatSends: (count: number) => `${count} sends`,
  formatQuality: (value: string) => value,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../MarqueeText', () => ({
  MarqueeText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../DrawerHeader', () => ({
  DrawerHeader: ({ center }: { center?: ReactNode }) => createElement('div', null, center),
}));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../../../hooks/use-ascent-status', () => ({
  useAscentStatus: (climbUuid: string, angle: number) =>
    statusByClimbAngle.get(climbAngleKey(climbUuid, angle)) ?? null,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#8E8E93' } }),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

import { PlayDrawerHeader } from '../PlayDrawerHeader';

const baseProps = {
  climbUuid: 'climb-1',
  angle: 40,
  name: 'Hueco Madness',
  difficulty: 'V6',
  qualityAverage: '0',
  ascensionistCount: 0,
  setterUsername: '',
};

describe('PlayDrawerHeader ascent status', () => {
  beforeEach(() => statusByClimbAngle.clear());

  it.each([
    ['flash', 'flash', 'mobile.climbRow.ascentStatus.flash'],
    ['send', 'tick.outline', 'mobile.climbRow.ascentStatus.send'],
    ['attempt', 'ascent.attempt', 'mobile.climbRow.ascentStatus.attempt'],
  ] as const)('shows the canonical %s glyph and label', (status, icon, label) => {
    statusByClimbAngle.set(climbAngleKey('climb-1', 40), status);
    const { container, getByLabelText } = render(createElement(PlayDrawerHeader, baseProps));

    expect(getByLabelText(label)).toBeTruthy();
    expect(container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe(icon);
  });

  it('omits the marker when the current angle has no prior history', () => {
    statusByClimbAngle.set(climbAngleKey('climb-1', 30), 'flash');
    const { container } = render(createElement(PlayDrawerHeader, baseProps));

    expect(container.querySelector('[data-icon]')).toBeNull();
  });

  it('updates when the current angle or displayed climb prop changes', () => {
    statusByClimbAngle.set(climbAngleKey('climb-1', 40), 'flash');
    statusByClimbAngle.set(climbAngleKey('climb-1', 30), 'attempt');
    statusByClimbAngle.set(climbAngleKey('climb-2', 30), 'send');
    const { container, rerender } = render(createElement(PlayDrawerHeader, baseProps));
    expect(container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('flash');

    rerender(createElement(PlayDrawerHeader, { ...baseProps, angle: 30 }));
    expect(container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('ascent.attempt');

    rerender(createElement(PlayDrawerHeader, { ...baseProps, climbUuid: 'climb-2', angle: 30 }));
    expect(container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('tick.outline');
  });
});
