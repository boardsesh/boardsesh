// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', () => ({ PressableSurface: () => null }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AccessibilityActionEvent } from 'react-native';

type StandInProps = {
  children?: ReactNode;
  testID?: string;
  pointerEvents?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityActions?: { name: string; label?: string }[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
};

const recorded = vi.hoisted(() => ({
  onAccessibilityAction: undefined as ((event: AccessibilityActionEvent) => void) | undefined,
  pill: null as { label: string; hint?: string } | null,
}));

// react-native isn't satisfiable under jsdom. The stand-in's View becomes a div
// that surfaces its label and actions, and hands its action handler to the test.
vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    pointerEvents,
    accessibilityRole,
    accessibilityLabel,
    accessibilityActions,
    onAccessibilityAction,
  }: StandInProps) => {
    if (testID === 'play-drawer-header-accessibility') recorded.onAccessibilityAction = onAccessibilityAction;
    return createElement(
      'div',
      {
        'data-testid': testID,
        'data-pointer-events': pointerEvents,
        'data-role': accessibilityRole,
        'aria-label': accessibilityLabel,
        'data-actions': accessibilityActions ? JSON.stringify(accessibilityActions) : undefined,
      },
      children,
    );
  },
  StyleSheet: {
    absoluteFill: {},
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
  },
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'setter' in options
        ? `${key}:${String(options.setter)}`
        : options && 'angle' in options
          ? `${key}:${String(options.angle)}`
          : key,
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
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../MarqueeText', () => ({ MarqueeText: () => null }));
vi.mock('../../DrawerHeader', () => ({ DrawerHeader: () => null }));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../DraftChip', () => ({ DraftChip: () => null }));
vi.mock('../../ProjectChip', () => ({ ProjectChip: () => null }));
// The pill's own words are covered by wall-state-pill.test.tsx; here the
// stand-in only has to carry them onto its action.
vi.mock('../WallStatePill', () => ({
  useWallStatePillAccessibility: ({ state }: { state: string | null }) => (state ? recorded.pill : null),
}));

import { PlayDrawerHeaderAccessibility } from '../PlayDrawerHeaderAccessibility';
import type { LivePlayDrawerHeaderModel } from '../PlayDrawerHeader';

const modelWith = (headerProps: Partial<LivePlayDrawerHeaderModel['headerProps']> = {}): LivePlayDrawerHeaderModel => ({
  headerProps: {
    name: 'Hueco Madness',
    difficulty: 'V6',
    qualityAverage: '2.5',
    ascensionistCount: 12,
    setterUsername: 'jwebxl',
    boardName: 'kilter',
    angle: 40,
    ...headerProps,
  },
  layoutFingerprint: 'fingerprint',
  reduceMotion: false,
});

const baseProps = { pillState: null, pillBackTarget: null, pillLatched: false };

const actionNames = (element: HTMLElement) =>
  (JSON.parse(element.dataset.actions ?? '[]') as { name: string; label?: string }[]).map(({ name }) => name);

const fireAction = (actionName: string) =>
  recorded.onAccessibilityAction?.({ nativeEvent: { actionName } } as AccessibilityActionEvent);

describe('PlayDrawerHeaderAccessibility', () => {
  beforeEach(() => {
    recorded.onAccessibilityAction = undefined;
    recorded.pill = { label: 'playView.wallState.live', hint: 'hint' };
  });

  it('reads the whole header as one header-role label', () => {
    const { getByTestId } = render(createElement(PlayDrawerHeaderAccessibility, { ...baseProps, model: modelWith() }));
    const standIn = getByTestId('play-drawer-header-accessibility');
    expect(standIn.dataset.role).toBe('header');
    expect(standIn.getAttribute('aria-label')).toBe('Hueco Madness, V6, 12 sends, 2.5★, jwebxl');
  });

  it('lets sighted taps through to the drawn header it sits on top of', () => {
    const { getByTestId } = render(createElement(PlayDrawerHeaderAccessibility, { ...baseProps, model: modelWith() }));
    expect(getByTestId('play-drawer-header-accessibility').dataset.pointerEvents).toBe('box-none');
  });

  it('says the benchmark and no-match glyphs the drawn header puts after the name', () => {
    const { getByTestId, rerender } = render(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith({ benchmarkDifficulty: '18', characteristics: ['no_match', 'method_footless'] }),
      }),
    );
    expect(getByTestId('play-drawer-header-accessibility').getAttribute('aria-label')).toBe(
      'Hueco Madness, mobile.climbRow.benchmark, mobile.climbRow.noMatch, mobile.climbRow.method.footless, V6, 12 sends, 2.5★, jwebxl',
    );

    // A climb that carries only the legacy no-match bool, like the glyph does.
    rerender(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith({ characteristics: null, isNoMatch: true }),
      }),
    );
    expect(getByTestId('play-drawer-header-accessibility').getAttribute('aria-label')).toBe(
      'Hueco Madness, mobile.climbRow.noMatch, V6, 12 sends, 2.5★, jwebxl',
    );
  });

  it('keeps the rules the Woods rules line does not state, and not the ones it does', () => {
    const { getByTestId } = render(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith({
          boardName: 'woods',
          characteristics: ['no_match', 'any_feet', 'no_kickboard'],
          isNoMatch: true,
        }),
      }),
    );
    expect(getByTestId('play-drawer-header-accessibility').getAttribute('aria-label')).toBe(
      'Hueco Madness, mobile.climbRow.noKickboard, V6, 12 sends, 2.5★, jwebxl, mobile.climbRules.spoken',
    );
  });

  it('says what the wall is doing, but not the browsing pill, whose words are its action', () => {
    recorded.pill = { label: 'On the wall. Alex is lighting the wall.', hint: 'hint' };
    const { getByTestId, rerender } = render(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith(),
        pillState: 'onWall',
        onPillPress: () => {},
      }),
    );
    expect(getByTestId('play-drawer-header-accessibility').getAttribute('aria-label')).toBe(
      'Hueco Madness, V6, 12 sends, 2.5★, jwebxl, On the wall. Alex is lighting the wall.',
    );

    recorded.pill = { label: 'Back to your climb' };
    rerender(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith(),
        pillState: 'browsing',
        onPillPress: () => {},
      }),
    );
    expect(getByTestId('play-drawer-header-accessibility').getAttribute('aria-label')).toBe(
      'Hueco Madness, V6, 12 sends, 2.5★, jwebxl',
    );
  });

  it('says draft, hidden and the set angle when the drawn header would', () => {
    const { getByTestId } = render(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith({ ascensionistCount: 0, qualityAverage: null, isDraft: true, isHidden: true, statsAngle: 30 }),
      }),
    );
    expect(getByTestId('play-drawer-header-accessibility').getAttribute('aria-label')).toBe(
      'Hueco Madness, createClimbForm.draftBadge, V6, jwebxl, mobile.hidden.banner, mobile.climbRow.setAngleMarkerAria:30',
    );
  });

  it('says project for a climb nobody has graded, like the chip it stands in for', () => {
    const { getByTestId } = render(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith({ difficulty: '', ascensionistCount: 0, qualityAverage: null, statsAngle: 40 }),
      }),
    );
    expect(getByTestId('play-drawer-header-accessibility').getAttribute('aria-label')).toBe(
      'Hueco Madness, mobile.project.chip, jwebxl',
    );
  });

  it('offers only the actions that have a handler', () => {
    const { getByTestId, rerender } = render(
      createElement(PlayDrawerHeaderAccessibility, { ...baseProps, model: modelWith() }),
    );
    expect(actionNames(getByTestId('play-drawer-header-accessibility'))).toEqual([]);

    rerender(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith({ setterUsername: '' }),
        onLongPressName: () => {},
        onPressSetter: () => {},
        pillState: 'live',
        onPillPress: () => {},
      }),
    );
    // No setter on this climb, so no setter action even with a handler.
    expect(actionNames(getByTestId('play-drawer-header-accessibility'))).toEqual(['copyName', 'wallPill']);
  });

  it('names the setter and wall-pill actions with what the drawn controls say', () => {
    const { getByTestId } = render(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith(),
        onLongPressName: () => {},
        onPressSetter: () => {},
        pillState: 'browsing',
        onPillPress: () => {},
      }),
    );
    const actions = JSON.parse(getByTestId('play-drawer-header-accessibility').dataset.actions ?? '[]');
    expect(actions).toEqual([
      { name: 'copyName', label: 'mobile.climbActions.copyName' },
      { name: 'openSetter', label: 'frontDoor.setterLink:jwebxl' },
      { name: 'wallPill', label: 'playView.wallState.live' },
    ]);
  });

  it('runs the matching control for each action', () => {
    const onLongPressName = vi.fn();
    const onPressSetter = vi.fn();
    const onPillPress = vi.fn();
    render(
      createElement(PlayDrawerHeaderAccessibility, {
        ...baseProps,
        model: modelWith(),
        onLongPressName,
        onPressSetter,
        pillState: 'onWall',
        onPillPress,
      }),
    );

    fireAction('copyName');
    expect(onLongPressName).toHaveBeenCalledTimes(1);
    expect(onPressSetter).not.toHaveBeenCalled();
    expect(onPillPress).not.toHaveBeenCalled();

    fireAction('openSetter');
    expect(onPressSetter).toHaveBeenCalledTimes(1);

    fireAction('wallPill');
    expect(onPillPress).toHaveBeenCalledTimes(1);

    fireAction('activate');
    expect(onLongPressName).toHaveBeenCalledTimes(1);
    expect(onPressSetter).toHaveBeenCalledTimes(1);
    expect(onPillPress).toHaveBeenCalledTimes(1);
  });
});
