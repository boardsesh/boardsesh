// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

// #3914: ClimbListRow's press and its ⋮ button both live on RNGH gestures, whose
// native recognizers never register with React Native's accessibility-action
// bridge — a VoiceOver/TalkBack activate reached nothing. Both elements must expose
// onAccessibilityTap plus an `activate` accessibility action that call the same
// handlers the taps do. These tests capture the props the component actually
// renders and invoke them, so reverting the fix leaves them undefined and fails.
type AccessibilityCapture = {
  onAccessibilityTap?: () => void;
  accessibilityActions?: { name: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};

const a11y = vi.hoisted(() => ({
  row: null as null | AccessibilityCapture,
  moreButton: null as null | AccessibilityCapture,
}));

vi.mock('react-native', () => {
  const capture = (props: AccessibilityCapture): AccessibilityCapture => ({
    onAccessibilityTap: props.onAccessibilityTap,
    accessibilityActions: props.accessibilityActions,
    onAccessibilityAction: props.onAccessibilityAction,
  });
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    View: ({ children, testID, ...rest }: { children?: ReactNode; testID?: string } & AccessibilityCapture) => {
      if (testID === 'climb-row') a11y.row = capture(rest);
      if (testID === 'climb-row-more-button') a11y.moreButton = capture(rest);
      return createElement('div', null, children);
    },
    StyleSheet: {
      create: (styles: Record<string, unknown>) => styles,
      hairlineWidth: 1,
    },
  };
});

vi.mock('react-native-reanimated', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    default: { View: passthrough },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useAnimatedReaction: () => undefined,
    interpolate: () => 0,
    Extrapolation: { CLAMP: 'clamp' },
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

vi.mock('react-native-gesture-handler', () => {
  // Chainable no-op gesture builder — this file only cares about the accessibility
  // channel, so nothing needs capturing off the gestures themselves.
  const makeBuilder = () => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    const proxy: typeof builder = new Proxy(builder, {
      get: () => () => proxy,
    });
    return proxy;
  };
  return {
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Gesture: {
      Tap: () => makeBuilder(),
      LongPress: () => makeBuilder(),
      Exclusive: () => ({}),
    },
  };
});

vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

vi.mock('../../lib/haptics', () => ({
  hapticLight: vi.fn(),
  hapticMedium: vi.fn(),
  hapticSuccess: vi.fn(),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', separator: '#ccc', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9', success: '#0a0' },
  }),
}));

vi.mock('../use-swipe-arm', () => ({
  useSwipeArm: () => ({ armedRef: { current: false }, arm: vi.fn(), disarm: vi.fn() }),
}));

vi.mock('../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));

vi.mock('../ClimbListItemContent', () => ({
  ClimbListItemContent: ({ climb }: { climb?: { name?: string } }) =>
    createElement('span', { 'data-climb-name': climb?.name ?? '' }),
}));

vi.mock('../climb-list-row-styles', () => ({
  climbListRowStyles: { contentRow: {}, separator: {} },
}));

vi.mock('../climb-list-row-colors', () => ({
  selectedRowColors: () => ({ fill: '#eee', accent: '#6D28D9' }),
}));

import { ClimbListRow } from '../ClimbListRow';

const climb = { uuid: 'climb-1', name: 'Crimp Master' } as Climb;

const boardProps = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

describe('ClimbListRow screen-reader activation', () => {
  beforeEach(() => {
    a11y.row = null;
    a11y.moreButton = null;
    vi.clearAllMocks();
  });

  it('opens the climb from a screen-reader tap and from the activate action', () => {
    const onPress = vi.fn();
    render(<ClimbListRow climb={climb} {...boardProps} onPress={onPress} />);

    expect(a11y.row?.onAccessibilityTap).toBeTypeOf('function');
    expect(a11y.row?.accessibilityActions).toEqual([{ name: 'activate' }]);
    expect(a11y.row?.onAccessibilityAction).toBeTypeOf('function');

    a11y.row?.onAccessibilityTap?.();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith(climb);

    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    expect(onPress).toHaveBeenCalledTimes(2);

    // Any other action name is a no-op — a handler that fires on every action
    // would misroute a custom action a later PR adds to this row.
    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'magicTap' } });
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('leaves an unsupported row inert under a screen-reader activation', () => {
    const onPress = vi.fn();
    render(<ClimbListRow climb={climb} {...boardProps} onPress={onPress} unsupported />);

    a11y.row?.onAccessibilityTap?.();
    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    expect(onPress).not.toHaveBeenCalled();
  });

  it('opens the actions menu from a screen-reader activation of the ⋮ button', () => {
    const onOpenActions = vi.fn();
    const onPress = vi.fn();
    render(
      <ClimbListRow climb={climb} {...boardProps} onPress={onPress} onOpenActions={onOpenActions} showMoreButton />,
    );

    expect(a11y.moreButton?.onAccessibilityTap).toBeTypeOf('function');
    expect(a11y.moreButton?.accessibilityActions).toEqual([{ name: 'activate' }]);

    a11y.moreButton?.onAccessibilityTap?.();
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    expect(onOpenActions).toHaveBeenCalledWith(climb);

    a11y.moreButton?.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    expect(onOpenActions).toHaveBeenCalledTimes(2);

    a11y.moreButton?.onAccessibilityAction?.({ nativeEvent: { actionName: 'magicTap' } });
    expect(onOpenActions).toHaveBeenCalledTimes(2);
    // Activating the button must not also press the row.
    expect(onPress).not.toHaveBeenCalled();
  });

  it('shares one module-level activate-action array across the row and its ⋮ button', () => {
    render(<ClimbListRow climb={climb} {...boardProps} onPress={vi.fn()} onOpenActions={vi.fn()} showMoreButton />);
    expect(a11y.row?.accessibilityActions).toBeDefined();
    expect(a11y.moreButton?.accessibilityActions).toBe(a11y.row?.accessibilityActions);
  });
});
