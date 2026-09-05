// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// react-native isn't satisfiable under jsdom; stub the surface the header touches.
// Pressable becomes a <button> whose click fires onLongPress (so we can drive the
// long-press path) and honours `disabled` (the peek header passes no handler).
// Dynamic Type multiplier the header sees. Hoisted because the react-native
// factory below is lifted above every top-level binding.
const typeScale = vi.hoisted(() => ({ current: 1 }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  // The header drops its second grade line above a 1.3 font scale rather than
  // clamping Dynamic Type. Controllable so that branch is testable.
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: typeScale.current }),
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
  // Render the center column so the name Pressable is in the tree, and the
  // trailing column so the grade block is too. `trailingMinWidth` is surfaced as
  // an attribute: the header pins it so the measured flank stays constant across
  // climbs, which is what stops the centred name's marquee restarting on swipe.
  DrawerHeader: ({
    center,
    trailing,
    trailingMinWidth,
  }: {
    center?: ReactNode;
    trailing?: ReactNode;
    trailingMinWidth?: number;
  }) =>
    createElement(
      'div',
      { 'data-trailing-min-width': trailingMinWidth },
      center,
      createElement('div', { 'data-testid': 'trailing' }, trailing),
    ),
}));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => createElement('i', null) }));
// The real Icon pulls in react-native-vector-icons, which this suite's
// `react-native` stub can't satisfy — and the grade glyphs are not what it tests.
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));

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

// #4796 / #4828: the drawer header is the screen you hand your partner to show
// them the beta, so an unlabelled headline number that is actually your private
// opinion has to say whose it is.
describe('PlayDrawerHeader personal grade', () => {
  beforeEach(() => {
    typeScale.current = 1;
  });

  const icons = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-icon]')].map((node) => node.getAttribute('data-icon'));

  it('renders one bare grade and no marker when the grade is not yours', () => {
    const { container } = render(createElement(PlayDrawerHeader, baseProps));
    expect(container.textContent).toContain('V6');
    expect(icons(container)).not.toContain('person');
    expect(icons(container)).not.toContain('people');
  });

  it('marks your grade and demotes the crowd’s beneath it', () => {
    const { container } = render(
      createElement(PlayDrawerHeader, { ...baseProps, difficulty: 'V10', markedAsMine: true, secondaryGrade: 'V0' }),
    );
    const trailing = container.querySelector('[data-testid="trailing"]') as HTMLElement;
    expect(trailing.textContent).toContain('V10');
    expect(trailing.textContent).toContain('V0');
    expect(icons(trailing)).toEqual(expect.arrayContaining(['person', 'people']));
  });

  it('drops the crowd line above a 1.3 font scale rather than clamping Dynamic Type', () => {
    // The header pins a 44pt row so the board art below cannot shift, and the
    // headline alone eats that floor once type is scaled up. The same
    // information is spelled out in the Grades section, which scrolls.
    typeScale.current = 1.4;
    const { container } = render(
      createElement(PlayDrawerHeader, { ...baseProps, difficulty: 'V10', markedAsMine: true, secondaryGrade: 'V0' }),
    );
    const trailing = container.querySelector('[data-testid="trailing"]') as HTMLElement;
    expect(trailing.textContent).toContain('V10');
    expect(trailing.textContent).not.toContain('V0');
    // Your own number stays marked — dropping the marker would leave a bare
    // private opinion on a screen someone else is reading.
    expect(icons(trailing)).toContain('person');
  });

  it('pins the trailing flank so the centred name stops re-measuring per climb', () => {
    const { container } = render(createElement(PlayDrawerHeader, baseProps));
    expect(container.querySelector('[data-trailing-min-width]')?.getAttribute('data-trailing-min-width')).toBe('72');
  });
});
