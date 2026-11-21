// @vitest-environment jsdom
import { createElement, type CSSProperties, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type TestStyle = Record<string, unknown> | null | undefined | false | TestStyle[];

// Paint the styles in the DOM: an opaque mock View would accept the native
// property even though the browser cannot paint a gradient for it. Keep this
// suite runnable without installing the separate Expo browser runtime.
vi.mock('react-native', () => {
  const flatten = (style: TestStyle): Record<string, unknown> =>
    Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style || {};
  const view = ({ children, style, testID }: { children?: ReactNode; style?: TestStyle; testID?: string }) => {
    // React Native transform arrays are unrelated to the gradient contract.
    const { transform: _transform, ...browserStyle } = flatten(style);
    return createElement('div', { 'data-testid': testID, style: browserStyle as CSSProperties }, children);
  };
  class Value {
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
    }
  }
  return {
    View: view,
    Image: () => null,
    Platform: { OS: 'web' },
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Animated: { View: view, Value },
  };
});
vi.mock('../../lib/gradient-background', () => import('../../lib/gradient-background.web'));
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => true }));
vi.mock('@boardsesh/frosted-bokeh/grain.png', () => ({ default: { uri: '/grain.png' } }));
vi.mock('../../../modules/frosted-bokeh-gpu/src/index', () => ({
  frostedBokehSwapFrameApi: 0,
  NativeFrostedBokehGPU: null,
}));
vi.mock('../use-frost-swap-frame', () => ({
  INITIAL_FROST_SWAP_FRAME: [0],
  useFrostSwapFrame: () => ({ target: null, latest: { value: null } }),
}));
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  return {
    default: { View },
    useAnimatedProps: (factory: () => unknown) => factory(),
    useAnimatedStyle: (factory: () => unknown) => factory(),
  };
});

import { WallGlow } from '../play-drawer/WallGlow';
import type { WallGlowLayer } from '../play-drawer/use-wall-glow';
import { WallSwipeWipe } from '../play-drawer/WallSwipeWipe';
import type { SharedValue } from 'react-native-reanimated';

afterEach(cleanup);

const firstGradient = 'radial-gradient(circle, rgb(0, 221, 0) 0%, rgba(0, 221, 0, 0) 100%)';
const nextGradient = 'radial-gradient(circle, rgb(255, 0, 0) 0%, rgba(255, 0, 0, 0) 100%)';

function layer(gradient = firstGradient): WallGlowLayer {
  return {
    key: gradient,
    blobs: [{ x: 40, y: 20, r: 40, color: '#00DD00', peak: 0.5, gradient }],
    fade: 0.35,
    surface: { base: '#0E0D12', label: '#FFFFFF', frost: true, border: 'rgba(255, 255, 255, 0.2)' },
    blend: 'screen',
    opacityScale: 1,
  };
}

describe('the wall button frost in the browser', () => {
  it('paints hold colours and the readability gradient instead of an unsupported native style', () => {
    const view = render(createElement(WallGlow, { layer: layer(), width: 360 }));
    const blob = view.getByTestId('wall-glow-blobs').firstElementChild;
    expect(blob).not.toBeNull();
    expect(getComputedStyle(blob!).backgroundImage).toBe(firstGradient);
    expect(getComputedStyle(view.getByTestId('wall-glow-label-fade')).backgroundImage).toContain('linear-gradient(');
    expect(view.getByTestId('wall-glow-frost')).toBeTruthy();
  });

  it('updates the painted holds when the climb changes with Reduce Motion enabled', () => {
    const view = render(createElement(WallGlow, { layer: layer(), width: 360 }));
    view.rerender(createElement(WallGlow, { layer: layer(nextGradient), width: 360 }));
    const blob = view.getByTestId('wall-glow-blobs').firstElementChild;
    expect(getComputedStyle(blob!).backgroundImage).toBe(nextGradient);
    expect(view.getAllByTestId('wall-glow-blobs')).toHaveLength(1);
  });

  it('paints the feather on the wall button swipe progress', () => {
    const view = render(
      createElement(WallSwipeWipe, {
        progress: { value: 0.5 } as SharedValue<number>,
        opacity: { value: 1 } as SharedValue<number>,
        width: 360,
        fill: '#FFAA00',
      }),
    );
    expect(getComputedStyle(view.getByTestId('play-drawer-wall-control-wipe-edge')).backgroundImage).toContain(
      'linear-gradient(',
    );
  });
});
