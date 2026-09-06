// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// react-native isn't satisfiable under jsdom; stub the surface the header touches.
// Pressable becomes a <button> whose click fires onLongPress (so we can drive the
// long-press path) and honours `disabled` (the peek header passes no handler).
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  Pressable: ({
    children,
    onLongPress,
    disabled,
    accessibilityHint,
  }: {
    children?: ReactNode;
    onLongPress?: () => void;
    disabled?: boolean;
    accessibilityHint?: string;
  }) =>
    createElement(
      'button',
      { onClick: () => onLongPress?.(), disabled, 'aria-label': 'name-pressable', title: accessibilityHint ?? '' },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
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
// MarqueeText (the scrolling climb-name label) has its own unit test; here it's a
// plain text node so the long-press wrapper + name lookup work without Reanimated.
vi.mock('../../MarqueeText', () => ({
  MarqueeText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../DrawerHeader', () => ({
  // Render the center column so the name Pressable is in the tree.
  DrawerHeader: ({ center }: { center?: ReactNode }) => createElement('div', null, center),
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

describe('PlayDrawerHeader long-press copy', () => {
  it('fires onLongPressName when the name is long-pressed', () => {
    const onLongPressName = vi.fn();
    const { getByLabelText, getByText } = render(createElement(PlayDrawerHeader, { ...baseProps, onLongPressName }));
    expect(getByText('Hueco Madness')).toBeTruthy();
    fireEvent.click(getByLabelText('name-pressable'));
    expect(onLongPressName).toHaveBeenCalledTimes(1);
  });

  it('renders the name without an interactive press target on the peek header (no handler)', () => {
    const { getByLabelText, getByText } = render(createElement(PlayDrawerHeader, baseProps));
    expect(getByText('Hueco Madness')).toBeTruthy();
    // The Pressable is disabled when no handler is supplied (swipe "peek" header).
    expect((getByLabelText('name-pressable') as HTMLButtonElement).disabled).toBe(true);
  });
});
