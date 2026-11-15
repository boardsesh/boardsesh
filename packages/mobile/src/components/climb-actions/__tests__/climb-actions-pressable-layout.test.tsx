// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Yoga from 'yoga-layout';
import type { AccessibilityActionEvent, ViewStyle } from 'react-native';
import type { ClimbActionsTarget } from '../../../providers/drawer-host-provider';

const runtime = vi.hoisted(() => ({
  bodyStyle: undefined as unknown,
  tap: undefined as undefined | { onActivate: () => void },
  accessibilityTap: undefined as undefined | (() => void),
  accessibilityAction: undefined as undefined | ((event: AccessibilityActionEvent) => void),
  menuAction: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-gesture-handler', () => ({
  useTapGesture: (gesture: { onActivate: () => void }) => {
    runtime.tap = gesture;
    return gesture;
  },
  GestureDetector: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: (props: {
      children: ReactNode;
      style: unknown;
      onAccessibilityTap: () => void;
      onAccessibilityAction: (event: AccessibilityActionEvent) => void;
    }) => {
      runtime.bodyStyle = props.style;
      runtime.accessibilityTap = props.onAccessibilityTap;
      runtime.accessibilityAction = props.onAccessibilityAction;
      return createElement('div', null, props.children);
    },
  },
  runOnJS: <Callback extends (...args: never[]) => unknown>(callback: Callback) => callback,
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedStyle: (style: () => unknown) => style(),
  withSpring: (target: number) => target,
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../ClimbActionsMenu', () => ({
  useClimbMenu: () => ({
    rows: [],
    menuKey: 'highlight',
    accessibilityActions: [{ name: 'share', label: 'Share' }],
    onAccessibilityAction: runtime.menuAction,
  }),
  ClimbMenu: ({ children }: { children: ReactNode }) => children,
}));

import { ClimbActionsPressable } from '../ClimbActionsPressable';

function flattenStyle(style: unknown): ViewStyle {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style && typeof style === 'object' ? (style as ViewStyle) : {};
}

const target = { climb: { uuid: 'highlight', name: 'Amber' } } as ClimbActionsTarget;
// SessionFeedCard's existing heroPressable margin and padding must retain their
// geometry when its body moves into iOS/Android's horizontal menu host.
const heroStyle: ViewStyle = { margin: -4, padding: 4, borderRadius: 8 };

function renderBody(menuTarget: ClimbActionsTarget | null = target, style: ViewStyle = heroStyle) {
  const onPress = vi.fn();
  const rendered = render(
    <ClimbActionsPressable target={menuTarget} onPress={onPress} style={style}>
      <span>Amber V10</span>
    </ClimbActionsPressable>,
  );
  return { ...rendered, onPress };
}

function measureHero(hostWidth: number, hosted: boolean, climbName = 'Amber') {
  const bodyStyle = flattenStyle(runtime.bodyStyle);
  const host = Yoga.Node.create();
  host.setWidth(hostWidth);
  host.setFlexDirection(hosted ? Yoga.FLEX_DIRECTION_ROW : Yoga.FLEX_DIRECTION_COLUMN);
  const body = Yoga.Node.create();
  if (bodyStyle.flexGrow !== undefined) body.setFlexGrow(bodyStyle.flexGrow);
  if (bodyStyle.flexShrink !== undefined) body.setFlexShrink(bodyStyle.flexShrink);
  if (typeof bodyStyle.width === 'number') body.setWidth(bodyStyle.width);
  if (typeof bodyStyle.margin === 'number') body.setMargin(Yoga.EDGE_ALL, bodyStyle.margin);
  if (typeof bodyStyle.padding === 'number') body.setPadding(Yoga.EDGE_ALL, bodyStyle.padding);

  const hero = Yoga.Node.create();
  hero.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
  hero.setGap(Yoga.GUTTER_ALL, 12);
  const thumbnail = Yoga.Node.create();
  thumbnail.setWidth(84);
  thumbnail.setHeight(104);
  const details = Yoga.Node.create();
  details.setFlex(1);
  const title = Yoga.Node.create();
  // Approximate Text's constrained measurement; the regression is Yoga giving
  // the entire text column zero width, independent of font metrics.
  title.setMeasureFunc((width, mode) => ({
    width: mode === Yoga.MEASURE_MODE_UNDEFINED ? climbName.length * 10 : Math.min(width, climbName.length * 10),
    height: 25,
  }));
  details.insertChild(title, 0);
  hero.insertChild(thumbnail, 0);
  hero.insertChild(details, 1);
  body.insertChild(hero, 0);
  host.insertChild(body, 0);
  try {
    host.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
    return {
      bodyWidth: body.getComputedWidth(),
      bodyHeight: body.getComputedHeight(),
      detailsWidth: details.getComputedWidth(),
      titleWidth: title.getComputedWidth(),
    };
  } finally {
    host.freeRecursive();
  }
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ClimbActionsPressable hero layout', () => {
  it.each([
    [338, 'Amber'],
    [275, 'A very long highlight climb name that wraps'],
  ])('keeps the highlight text usable in a %i-point native menu host', (width, climbName) => {
    renderBody();
    const geometry = measureHero(width, true, climbName);
    expect(geometry.bodyWidth).toBe(width + 8);
    expect(geometry.detailsWidth).toBeGreaterThan(100);
    expect(geometry.titleWidth).toBeGreaterThan(0);
    expect(geometry.bodyHeight).toBe(112);
  });

  it('retains intrinsic height and full text width without a menu target', () => {
    renderBody(null);
    const geometry = measureHero(338, false);
    expect(geometry.bodyWidth).toBe(346);
    expect(geometry.bodyHeight).toBe(112);
    expect(geometry.detailsWidth).toBe(242);
    expect(geometry.titleWidth).toBeGreaterThan(0);
  });

  it('allows an explicit caller size to override the default fill behavior', () => {
    renderBody(target, { ...heroStyle, flexGrow: 0, flexShrink: 0, width: 200 });
    const geometry = measureHero(338, true);
    expect(geometry.bodyWidth).toBe(200);
    expect(geometry.detailsWidth).toBe(96);
    expect(geometry.titleWidth).toBeGreaterThan(0);
  });

  it('preserves touch, screen-reader activation, and menu actions', () => {
    const first = renderBody();
    runtime.tap?.onActivate();
    runtime.accessibilityTap?.();
    runtime.accessibilityAction?.({ nativeEvent: { actionName: 'activate' } } as AccessibilityActionEvent);
    expect(first.onPress).toHaveBeenCalledTimes(3);
    const shareEvent = { nativeEvent: { actionName: 'share' } } as AccessibilityActionEvent;
    runtime.accessibilityAction?.(shareEvent);
    expect(runtime.menuAction).toHaveBeenCalledExactlyOnceWith(shareEvent);
    expect(first.onPress).toHaveBeenCalledTimes(3);
  });
});
