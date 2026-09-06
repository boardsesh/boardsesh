// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// react-native isn't satisfiable under jsdom; stub the surface the header touches.
// Pressable becomes a <button> whose click fires onLongPress (so we can drive the
// long-press path) and honours `disabled` (the peek header passes no handler).
//
// No `useWindowDimensions` stub any more: the trailing flank is one line tall in
// every state, so the header no longer reads the Dynamic Type multiplier to
// decide whether to drop a second grade line.
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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#000000',
}));
vi.mock('../../../lib/format-climb-stats', () => ({
  formatSends: (count: number) => `${count} sends`,
  formatQuality: (value: string) => value,
}));
// Carries the variant so the grade slot's type tier is assertable: the header's
// number is `headline`, not the list row's `title3`.
vi.mock('../../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant }, children),
}));
// GradeValue reads its marker grey from the theme rather than a static hex.
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#8E8E93' } }),
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
// opinion has to say whose it is. A CATALOG surface — it is about the climb —
// so the crowd's number is the unremarkable one and yours wears the marker.
describe('PlayDrawerHeader personal grade', () => {
  const icons = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-icon]')].map((node) => node.getAttribute('data-icon'));
  const trailing = (container: HTMLElement) => container.querySelector('[data-testid="trailing"]') as HTMLElement;

  it('renders one bare grade and no marker when the grade is not yours', () => {
    const { container } = render(createElement(PlayDrawerHeader, baseProps));
    expect(trailing(container).textContent).toContain('V6');
    expect(icons(trailing(container))).not.toContain('person');
    expect(icons(trailing(container))).not.toContain('people');
  });

  it('marks your grade and moves the crowd’s onto the stats subtitle', () => {
    const { container } = render(
      createElement(PlayDrawerHeader, {
        ...baseProps,
        difficulty: 'V10',
        gradeSource: 'personal' as const,
        crowdGradeToken: 'V0',
      }),
    );

    // ONE number in the trailing flank, marked as yours.
    expect(trailing(container).textContent).toContain('V10');
    expect(trailing(container).textContent).not.toContain('V0');
    expect(icons(trailing(container))).toContain('person');
    expect(icons(trailing(container))).not.toContain('people');
    // The crowd's leads the line the header already had — no second grade row,
    // so no Dynamic-Type drop rule and no negative margin holding two together.
    expect(container.textContent).toContain('V0');
  });

  it('marks your grade even when the crowd agrees, with no subtitle token', () => {
    // The rule change: the marker answers "whose number is this", so it does
    // not switch off the moment the crowd happens to land on the same grade.
    const { container } = render(
      createElement(PlayDrawerHeader, {
        ...baseProps,
        difficulty: 'V6',
        gradeSource: 'personal' as const,
        crowdGradeToken: null,
      }),
    );

    expect(trailing(container).textContent).toContain('V6');
    expect(icons(trailing(container))).toContain('person');
  });

  it('renders the grade one line tall at the header’s headline tier', () => {
    // The trailing flank is pinned (below), and one line at headline/700 is
    // what makes `≈V17+` fit that pin in every state.
    const { container } = render(
      createElement(PlayDrawerHeader, { ...baseProps, difficulty: 'V10', gradeSource: 'personal' as const }),
    );
    const numbers = [...trailing(container).querySelectorAll('[data-variant]')];
    expect(numbers).toHaveLength(1);
    expect(numbers[0]?.getAttribute('data-variant')).toBe('headline');
  });

  it('pins the trailing flank so the centred name stops re-measuring per climb', () => {
    const { container } = render(createElement(PlayDrawerHeader, baseProps));
    expect(container.querySelector('[data-trailing-min-width]')?.getAttribute('data-trailing-min-width')).toBe('72');
  });
});
