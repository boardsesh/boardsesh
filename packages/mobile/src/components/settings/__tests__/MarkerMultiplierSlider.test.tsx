// @vitest-environment jsdom
//
// Regression guard for the release/terminate "tap commits the minimum" bug
// (issue #2202): React Native seeds `gestureState.moveX` at 0 and only updates
// it on a touch-MOVE, so a tap that presses and releases without ever moving
// reports `moveX === 0` on release. Recomputing the release value from that
// coordinate (as the component used to) would silently commit `min` no matter
// where the thumb actually was. The fix commits whatever `applyPageX` last
// actually applied, so release/terminate always land on the real thumb
// position — the grant coordinate, if the touch never moved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';

type ResponderEvent = { nativeEvent: { pageX: number } };
type ResponderConfig = {
  onPanResponderGrant?: (event: ResponderEvent) => void;
  onPanResponderMove?: (event: ResponderEvent, gestureState: { moveX: number }) => void;
  onPanResponderRelease?: (event: ResponderEvent, gestureState: { moveX: number }) => void;
  onPanResponderTerminate?: (event: ResponderEvent, gestureState: { moveX: number }) => void;
};
type MeasureCallback = (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void;
type ViewHandle = { measure: (callback: MeasureCallback) => void };
type ViewMockProps = ResponderConfig & {
  style?: unknown;
  accessible?: boolean;
  accessibilityLabel?: string;
  children?: ReactNode;
};

// Fixed track geometry: pageLeft 0, width 300 — a real `onLayout`-measured
// width, per the task's instruction to render with a fixed layout rather than
// exercising the deferred-measurement machinery (that's OkhslColorPicker's
// test file's job).
const TRACK_WIDTH = 300;
const harness = vi.hoisted(() => ({ config: null as ResponderConfig | null }));

vi.mock('react-native', () => {
  const View = forwardRef<ViewHandle, ViewMockProps>(function View(
    {
      accessible,
      accessibilityLabel,
      children,
      onPanResponderGrant,
      onPanResponderMove,
      onPanResponderRelease,
      onPanResponderTerminate,
      style,
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      measure: (callback) => callback(0, 0, TRACK_WIDTH, 6, 0, 0),
    }));
    if (accessible && accessibilityLabel) {
      harness.config = { onPanResponderGrant, onPanResponderMove, onPanResponderRelease, onPanResponderTerminate };
    }
    const flat = Object.assign({}, ...[style].flat(3).filter(Boolean)) as {
      backgroundColor?: string;
      borderColor?: string;
    };
    return createElement(
      'div',
      {
        'data-accessibility-label': accessibilityLabel,
        'data-bg': flat.backgroundColor,
        'data-border': flat.borderColor,
      },
      children,
    );
  });

  return {
    PanResponder: { create: (config: ResponderConfig) => ({ panHandlers: config }) },
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    View,
  };
});

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    // Distinct from `systemColors.accent` so the test can tell which one paints.
    brandColors: { primaryFill: '#7C3AED', onPrimary: '#FFFFFF' },
    systemColors: {
      accent: '#6D28D9',
      background: '#ffffff',
      secondaryLabel: '#888888',
      separator: '#cccccc',
    },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12 },
}));

import { MarkerMultiplierSlider } from '../MarkerMultiplierSlider.web';

const LABEL = 'test slider';

function grant(pageX: number) {
  harness.config?.onPanResponderGrant?.({ nativeEvent: { pageX } });
}

function move(moveX: number) {
  harness.config?.onPanResponderMove?.({ nativeEvent: { pageX: moveX } }, { moveX });
}

// A tap that releases (or is interrupted) without any intervening move — RN's
// real `gestureState.moveX` on such a release/terminate is 0, not the touch's
// last coordinate.
function releaseWithoutMove() {
  harness.config?.onPanResponderRelease?.({ nativeEvent: { pageX: 0 } }, { moveX: 0 });
}

function terminateWithoutMove() {
  harness.config?.onPanResponderTerminate?.({ nativeEvent: { pageX: 0 } }, { moveX: 0 });
}

beforeEach(() => {
  harness.config = null;
});

afterEach(() => {
  cleanup();
});

describe('MarkerMultiplierSlider — tint', () => {
  it('fills the track and rings the thumb with the native-control tint (primaryFill)', () => {
    const { container } = render(
      <MarkerMultiplierSlider
        accessibilityLabel={LABEL}
        value={1}
        min={0.5}
        max={2}
        step={0.1}
        format={String}
        onChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-bg="#7C3AED"]')).not.toBeNull();
    expect(container.querySelector('[data-border="#7C3AED"]')).not.toBeNull();
    expect(container.querySelector('[data-bg="#6D28D9"]')).toBeNull();
  });
});

describe('MarkerMultiplierSlider — tap-release commits the touched value, not the minimum', () => {
  it('commits the 80%-of-track value on a release that never moved', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    render(
      <MarkerMultiplierSlider
        accessibilityLabel={LABEL}
        value={0}
        min={0}
        max={1}
        step={0.01}
        format={(value) => value.toFixed(2)}
        onChange={onChange}
        onChangeEnd={onChangeEnd}
      />,
    );

    // 80% of a 300px track, pageLeft 0.
    grant(0.8 * TRACK_WIDTH);
    expect(onChange).toHaveBeenCalledWith(0.8);

    releaseWithoutMove();

    expect(onChangeEnd).toHaveBeenCalledTimes(1);
    expect(onChangeEnd).toHaveBeenCalledWith(0.8);
    expect(onChangeEnd).not.toHaveBeenCalledWith(0);
  });

  it('commits the touched value on a terminate that never moved', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    render(
      <MarkerMultiplierSlider
        accessibilityLabel={LABEL}
        value={0}
        min={0}
        max={1}
        step={0.01}
        format={(value) => value.toFixed(2)}
        onChange={onChange}
        onChangeEnd={onChangeEnd}
      />,
    );

    grant(0.8 * TRACK_WIDTH);
    expect(onChange).toHaveBeenCalledWith(0.8);

    terminateWithoutMove();

    expect(onChangeEnd).toHaveBeenCalledTimes(1);
    expect(onChangeEnd).toHaveBeenCalledWith(0.8);
    expect(onChangeEnd).not.toHaveBeenCalledWith(0);
  });

  it('still commits the exact final position for a real drag ending in a release', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    render(
      <MarkerMultiplierSlider
        accessibilityLabel={LABEL}
        value={0}
        min={0}
        max={1}
        step={0.01}
        format={(value) => value.toFixed(2)}
        onChange={onChange}
        onChangeEnd={onChangeEnd}
      />,
    );

    grant(0.2 * TRACK_WIDTH);
    move(0.5 * TRACK_WIDTH);
    move(0.8 * TRACK_WIDTH);
    // A real release still reports its own coordinate; the fix must not
    // regress the ordinary dragged-then-released path.
    harness.config?.onPanResponderRelease?.(
      { nativeEvent: { pageX: 0.8 * TRACK_WIDTH } },
      { moveX: 0.8 * TRACK_WIDTH },
    );

    expect(onChangeEnd).toHaveBeenCalledTimes(1);
    expect(onChangeEnd).toHaveBeenCalledWith(0.8);
  });
});
