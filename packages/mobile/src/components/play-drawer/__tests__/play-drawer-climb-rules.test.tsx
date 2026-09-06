// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';

// The Woods play-drawer header states BOTH climb rules under the subtitle — the
// point being that a climber never has to work out whether a missing label meant
// "default" or "we didn't render it".
//
// react-native isn't satisfiable under jsdom; stub the surface the header touches.
// @boardsesh/board-config is deliberately NOT stubbed: the whole gate is its
// `explicitClimbRules` capability, and a local copy of that table would let this
// suite pass while the real one says something else.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));
// The grade slot takes its marker grey from the theme. Stubbed because the real
// provider pulls expo-secure-store, which has no native module under jsdom.
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#8E8E93' } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}(${Object.values(options).join('|')})` : key,
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
// `numberOfLines` is forwarded as a data attribute so the "must not truncate"
// case below is testing the real prop rather than an attribute jsdom would drop
// on the floor either way.
vi.mock('../../Text', () => ({
  Text: ({
    children,
    testID,
    accessibilityLabel,
    numberOfLines,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    numberOfLines?: number;
  }) =>
    createElement(
      'span',
      {
        'data-testid': testID,
        'aria-label': accessibilityLabel,
        'data-number-of-lines': numberOfLines == null ? undefined : String(numberOfLines),
      },
      children,
    ),
}));
vi.mock('../../MarqueeText', () => ({
  MarqueeText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../DrawerHeader', () => ({
  DrawerHeader: ({ center }: { center?: ReactNode }) => createElement('div', null, center),
}));
// Rendered as a marker element carrying whatever characteristics it was handed,
// so a test can prove the header stops feeding it the tokens the rules line
// already spells out.
// The real Icon pulls in @expo/vector-icons, which this suite's react-native
// stub cannot satisfy — and the grade glyphs are not what it tests.
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../ClimbAttributeIcons', () => ({
  ClimbAttributeIcons: ({ characteristics }: { characteristics?: string[] | null }) =>
    createElement('i', { 'data-attr-icons': characteristics === null ? 'null' : JSON.stringify(characteristics) }),
}));

import { PlayDrawerHeader } from '../PlayDrawerHeader';

const { NO_MATCH, CAMPUS, ANY_FEET } = CLIMB_CHARACTERISTICS;

const baseProps = {
  name: 'Treat yo self',
  difficulty: 'V6',
  qualityAverage: '0',
  ascensionistCount: 0,
  setterUsername: '',
};

function renderHeader(props: Partial<Parameters<typeof PlayDrawerHeader>[0]>) {
  const { container } = render(createElement(PlayDrawerHeader, { ...baseProps, ...props }));
  return {
    container,
    rules: container.querySelector('[data-testid="play-drawer-climb-rules"]'),
    attrIcons: container.querySelector('[data-attr-icons]'),
  };
}

describe('play-drawer climb rules line', () => {
  it('states both rules on a Woods climb', () => {
    const { rules } = renderHeader({ boardName: 'woods', characteristics: [] });
    expect(rules?.textContent).toBe('mobile.climbRules.matchingAllowed · mobile.climbRules.markedHoldsOnly');
  });

  it.each([
    [[NO_MATCH], 'mobile.climbRules.noMatching · mobile.climbRules.markedHoldsOnly'],
    [[ANY_FEET], 'mobile.climbRules.matchingAllowed · mobile.climbRules.anyFeet'],
    [[CAMPUS], 'mobile.climbRules.matchingAllowed · mobile.climbRules.noFeet'],
    [[NO_MATCH, ANY_FEET], 'mobile.climbRules.noMatching · mobile.climbRules.anyFeet'],
    [[NO_MATCH, CAMPUS], 'mobile.climbRules.noMatching · mobile.climbRules.noFeet'],
  ])('renders %j as its own pair of rules', (characteristics, expected) => {
    const { rules } = renderHeader({ boardName: 'woods', characteristics });
    expect(rules?.textContent).toBe(expected);
  });

  it('says both rules are unrecorded when the climb carries no characteristics', () => {
    // A Woods row imported before the catalogue carried rule metadata. Showing
    // the defaults here would invent a rule the setter never authored.
    const { rules } = renderHeader({ boardName: 'woods', characteristics: null });
    expect(rules?.textContent).toBe('mobile.climbRules.matchingUnknown · mobile.climbRules.feetUnknown');
  });

  it('speaks the pair as one phrase for a screen reader', () => {
    const { rules } = renderHeader({ boardName: 'woods', characteristics: [ANY_FEET] });
    expect(rules?.getAttribute('aria-label')).toBe(
      'mobile.climbRules.spoken(mobile.climbRules.matchingAllowed|mobile.climbRules.anyFeet)',
    );
  });

  it('lets the rules wrap rather than truncating them', () => {
    // A truncated climb RULE is worse than a taller header, which the drawer
    // measures anyway. `numberOfLines` on this Text would silently ellipsize
    // "Matching allowed · Marked holds only" at large Dynamic Type sizes and on a
    // narrow phone in German. The subtitle above it DOES cap at one line, which
    // is what makes this an easy thing to copy by accident.
    const { container, rules } = renderHeader({ boardName: 'woods', characteristics: [] });
    expect(rules?.getAttribute('data-number-of-lines')).toBeNull();
    const subtitle = container.querySelector('span[data-number-of-lines="1"]');
    expect(subtitle).not.toBeNull();
    expect(subtitle).not.toBe(rules);
  });

  it('stops repeating those tokens in the glyph cluster beside the name', () => {
    const { attrIcons } = renderHeader({ boardName: 'woods', characteristics: [NO_MATCH, ANY_FEET] });
    expect(attrIcons?.getAttribute('data-attr-icons')).toBe('null');
  });

  it('keeps no-kickboard visible alongside Woods matching and feet rules', () => {
    const { attrIcons, rules } = renderHeader({
      boardName: 'woods',
      characteristics: [NO_MATCH, ANY_FEET, 'no_kickboard'],
    });
    expect(attrIcons?.getAttribute('data-attr-icons')).toBe(JSON.stringify(['no_kickboard']));
    expect(rules).not.toBeNull();
  });

  describe('boards that show only the exceptions', () => {
    it.each(['kilter', 'tension', 'moonboard'] as const)('renders no rules line on %s', (boardName) => {
      const { rules, attrIcons } = renderHeader({ boardName, characteristics: [NO_MATCH, ANY_FEET] });
      expect(rules).toBeNull();
      // ...and the glyph cluster keeps every token, exactly as before.
      expect(attrIcons?.getAttribute('data-attr-icons')).toBe(JSON.stringify([NO_MATCH, ANY_FEET]));
    });

    it('renders no rules line when the header is given no board at all', () => {
      expect(renderHeader({ characteristics: [NO_MATCH] }).rules).toBeNull();
    });
  });
});
