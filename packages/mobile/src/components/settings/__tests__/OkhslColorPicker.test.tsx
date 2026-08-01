// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Okhsl } from '../../../lib/okhsl';

type ResponderEvent = { nativeEvent: { pageX: number } };
type ResponderConfig = {
  onPanResponderGrant?: (event: ResponderEvent) => void;
  onPanResponderMove?: (event: ResponderEvent, gestureState: { moveX: number }) => void;
  onPanResponderRelease?: (event: ResponderEvent) => void;
  onPanResponderTerminate?: (event: ResponderEvent) => void;
};
type MeasureCallback = (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void;

const responderHarness = vi.hoisted(() => ({
  configs: [] as ResponderConfig[],
  deferMeasurements: false,
  measurementCallbacks: [] as MeasureCallback[],
  measurementCallCount: 0,
  sliderRenderCounts: {} as Record<string, number>,
}));
const okhslHarness = vi.hoisted(() => ({ conversionCount: 0 }));

type ViewHandle = {
  measure: (callback: MeasureCallback) => void;
};
type ViewMockProps = {
  accessible?: boolean;
  accessibilityLabel?: string;
  accessibilityValue?: { text?: string };
  children?: ReactNode;
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};

vi.mock('react-native', () => {
  const View = forwardRef<ViewHandle, ViewMockProps>(function View(
    { accessible, accessibilityLabel, accessibilityValue, children, onAccessibilityAction },
    ref,
  ) {
    useImperativeHandle(
      ref,
      () => ({
        measure: (callback) => {
          responderHarness.measurementCallCount += 1;
          if (responderHarness.deferMeasurements) {
            responderHarness.measurementCallbacks.push(callback);
          } else {
            callback(0, 0, 300, 14, 0, 0);
          }
        },
      }),
      [],
    );
    if (accessible && accessibilityLabel) {
      responderHarness.sliderRenderCounts[accessibilityLabel] =
        (responderHarness.sliderRenderCounts[accessibilityLabel] ?? 0) + 1;
    }
    return createElement(
      'div',
      {
        'data-accessibility-label': accessibilityLabel,
        'data-accessibility-value': accessibilityValue?.text,
        onDoubleClick: onAccessibilityAction
          ? () => onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
          : undefined,
      },
      children,
    );
  });

  return {
    PanResponder: {
      create: (config: ResponderConfig) => {
        responderHarness.configs.push(config);
        return { panHandlers: {} };
      },
    },
    StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
    View,
  };
});

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: ({
    accessibilityLabel,
    onChangeText,
    value,
  }: {
    accessibilityLabel?: string;
    onChangeText?: (nextValue: string) => void;
    value?: string;
  }) =>
    createElement('input', {
      'aria-label': accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
      value,
    }),
}));

type SvgMockProps = {
  children?: ReactNode;
  id?: string;
  offset?: number;
  stopColor?: string;
};

vi.mock('react-native-svg', () => ({
  default: ({ children }: SvgMockProps) => createElement('svg', null, children),
  Defs: ({ children }: SvgMockProps) => createElement('defs', null, children),
  LinearGradient: ({ children, id }: SvgMockProps) => createElement('g', { 'data-gradient': id ?? '' }, children),
  Rect: () => createElement('rect'),
  Stop: ({ offset, stopColor }: SvgMockProps) =>
    createElement('i', {
      'data-color': stopColor ?? '',
      'data-offset': String(offset ?? ''),
      'data-stop': 'true',
    }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      background: '#ffffff',
      fill: '#eeeeee',
      label: '#111111',
      secondaryLabel: '#666666',
      separator: '#cccccc',
    },
  }),
}));

vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { systemRed: '#ff3b30' },
}));

vi.mock('../../../theme/tokens', () => ({
  borderRadius: { md: 8 },
  spacing: { 2: 8, 3: 12, 4: 16 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../lib/okhsl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/okhsl')>();
  return {
    ...actual,
    okhslToHex: (okhsl: Okhsl) => {
      okhslHarness.conversionCount += 1;
      return actual.okhslToHex(okhsl);
    },
  };
});

import { OkhslColorPicker } from '../OkhslColorPicker';

const LIGHTNESS_LABEL = 'mobile.more.accessibility.sliders.lightness';
const SATURATION_LABEL = 'mobile.more.accessibility.sliders.saturation';
const HUE_LABEL = 'mobile.more.accessibility.sliders.hue';
const HEX_LABEL = 'mobile.more.accessibility.hexLabel';

function responderEvent(pageX: number): ResponderEvent {
  return { nativeEvent: { pageX } };
}

function responder(index: number): ResponderConfig {
  const config = responderHarness.configs[index];
  if (!config) throw new Error(`Missing PanResponder config at index ${index}`);
  return config;
}

function resolveNextMeasurement(width = 300, pageLeft = 0) {
  const callback = responderHarness.measurementCallbacks.shift();
  if (!callback) throw new Error('Missing deferred measurement callback');
  callback(0, 0, width, 14, pageLeft, 0);
}

function grant(index: number, pageX: number) {
  responder(index).onPanResponderGrant?.(responderEvent(pageX));
}

function move(index: number, moveX: number) {
  responder(index).onPanResponderMove?.(responderEvent(moveX), { moveX });
}

function release(index: number, pageX: number) {
  responder(index).onPanResponderRelease?.(responderEvent(pageX));
}

function terminate(index: number, pageX: number) {
  responder(index).onPanResponderTerminate?.(responderEvent(pageX));
}

function slider(container: HTMLElement, label: string): HTMLElement {
  const element = container.querySelector(`[data-accessibility-label="${label}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing slider ${label}`);
  return element;
}

function gradients(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-gradient]'));
}

function gradientColors(gradient: HTMLElement): string[] {
  return Array.from(gradient.querySelectorAll<HTMLElement>('[data-stop]'), (stop) => stop.dataset.color ?? '');
}

describe('OkhslColorPicker gradient updates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    responderHarness.configs.length = 0;
    responderHarness.deferMeasurements = false;
    responderHarness.measurementCallbacks.length = 0;
    responderHarness.measurementCallCount = 0;
    responderHarness.sliderRenderCounts = {};
    okhslHarness.conversionCount = 0;
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('coalesces rapid drag moves into one gradient rebuild per ~33 ms interval', () => {
    const onChange = vi.fn();
    render(<OkhslColorPicker value="#00ff00" onChange={onChange} />);

    expect(okhslHarness.conversionCount).toBe(37);
    expect(responderHarness.configs).toHaveLength(3);

    act(() => {
      grant(0, 30);
      for (let moveIndex = 0; moveIndex < 20; moveIndex += 1) {
        move(0, 60 + moveIndex * 6);
      }
    });

    // Every move still publishes one precise colour, but none of the 25
    // dependent gradient stops rebuild before the bounded timer fires.
    expect(onChange).toHaveBeenCalledTimes(21);
    expect(okhslHarness.conversionCount).toBe(37 + 21);
    expect(responderHarness.sliderRenderCounts[SATURATION_LABEL]).toBe(1);
    expect(responderHarness.sliderRenderCounts[HUE_LABEL]).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(okhslHarness.conversionCount).toBe(37 + 21);

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(okhslHarness.conversionCount).toBe(37 + 21 + 25);
    expect(responderHarness.sliderRenderCounts[SATURATION_LABEL]).toBe(2);
    expect(responderHarness.sliderRenderCounts[HUE_LABEL]).toBe(2);
    expect(responderHarness.configs).toHaveLength(3);
  });

  it('flushes the exact final gradient on release and leaves no stale trailing update', () => {
    const onChange = vi.fn();
    const { container } = render(<OkhslColorPicker value="#00ff00" onChange={onChange} />);
    const initialGradientColors = gradients(container).map(gradientColors);

    act(() => {
      grant(0, 60);
      move(0, 210);
      vi.advanceTimersByTime(10);
      move(0, 240);
      release(0, 270);
    });

    expect(slider(container, LIGHTNESS_LABEL).dataset.accessibilityValue).toBe('90%');
    const hexInput = container.querySelector<HTMLInputElement>(`[aria-label="${HEX_LABEL}"]`);
    expect(hexInput?.value).toBe(onChange.mock.lastCall?.[0]);
    expect(vi.getTimerCount()).toBe(0);

    const releasedGradients = gradients(container);
    expect(releasedGradients.map((gradient) => gradient.querySelectorAll('[data-stop]').length)).toEqual([12, 12, 13]);
    for (const gradient of releasedGradients) {
      const stops = gradient.querySelectorAll<HTMLElement>('[data-stop]');
      expect(stops[0]?.dataset.offset).toBe('0');
      expect(stops[stops.length - 1]?.dataset.offset).toBe('1');
      expect(Array.from(stops).every((stop) => /^#[0-9a-f]{6}$/i.test(stop.dataset.color ?? ''))).toBe(true);
    }

    const releasedGradientColors = releasedGradients.map(gradientColors);
    expect(releasedGradientColors[0]).toEqual(initialGradientColors[0]);
    expect(releasedGradientColors[1]).not.toEqual(initialGradientColors[1]);
    expect(releasedGradientColors[2]).not.toEqual(initialGradientColors[2]);
    const conversionsAfterRelease = okhslHarness.conversionCount;

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(okhslHarness.conversionCount).toBe(conversionsAfterRelease);
    expect(gradients(container).map(gradientColors)).toEqual(releasedGradientColors);
  });

  it('flushes termination and applies non-drag accessibility updates immediately', () => {
    const onChange = vi.fn();
    const { container } = render(<OkhslColorPicker value="#00ff00" onChange={onChange} />);

    act(() => {
      grant(2, 30);
      move(2, 150);
      vi.advanceTimersByTime(10);
      terminate(2, 225);
    });

    expect(slider(container, HUE_LABEL).dataset.accessibilityValue).toBe('270°');
    expect(vi.getTimerCount()).toBe(0);
    const conversionsAfterTerminate = okhslHarness.conversionCount;

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(okhslHarness.conversionCount).toBe(conversionsAfterTerminate);

    fireEvent.doubleClick(slider(container, SATURATION_LABEL));
    expect(vi.getTimerCount()).toBe(0);
    expect(okhslHarness.conversionCount).toBeGreaterThan(conversionsAfterTerminate);
    expect(onChange).toHaveBeenCalled();
  });

  it('cancels a pending gradient update when the picker unmounts', () => {
    const { unmount } = render(<OkhslColorPicker value="#00ff00" onChange={vi.fn()} />);

    act(() => {
      grant(1, 30);
      move(1, 210);
    });
    expect(vi.getTimerCount()).toBe(1);
    const conversionsBeforeUnmount = okhslHarness.conversionCount;

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(okhslHarness.conversionCount).toBe(conversionsBeforeUnmount);
  });

  it('coalesces grant, moves, and release behind one deferred measurement', () => {
    responderHarness.deferMeasurements = true;
    const onChange = vi.fn();
    const { container } = render(<OkhslColorPicker value="#00ff00" onChange={onChange} />);
    const conversionsBeforeDrag = okhslHarness.conversionCount;

    act(() => {
      grant(0, 30);
      move(0, 120);
      move(0, 180);
      release(0, 270);
    });

    expect(responderHarness.measurementCallCount).toBe(1);
    expect(responderHarness.measurementCallbacks).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(okhslHarness.conversionCount).toBe(conversionsBeforeDrag);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      resolveNextMeasurement();
    });

    expect(responderHarness.measurementCallCount).toBe(1);
    expect(responderHarness.measurementCallbacks).toHaveLength(0);
    expect(slider(container, LIGHTNESS_LABEL).dataset.accessibilityValue).toBe('90%');
    expect(onChange).toHaveBeenCalledTimes(1);
    const hexInput = container.querySelector<HTMLInputElement>(`[aria-label="${HEX_LABEL}"]`);
    expect(hexInput?.value).toBe(onChange.mock.lastCall?.[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a deferred measurement after unmount', () => {
    responderHarness.deferMeasurements = true;
    const onChange = vi.fn();
    const { unmount } = render(<OkhslColorPicker value="#00ff00" onChange={onChange} />);

    act(() => {
      grant(0, 30);
      move(0, 210);
    });
    expect(responderHarness.measurementCallCount).toBe(1);
    expect(responderHarness.measurementCallbacks).toHaveLength(1);
    const conversionsBeforeUnmount = okhslHarness.conversionCount;

    unmount();
    act(() => {
      resolveNextMeasurement();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(okhslHarness.conversionCount).toBe(conversionsBeforeUnmount);
    expect(responderHarness.measurementCallCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an old measurement when a newer drag starts before it resolves', () => {
    responderHarness.deferMeasurements = true;
    const onChange = vi.fn();
    const { container } = render(<OkhslColorPicker value="#00ff00" onChange={onChange} />);
    const conversionsBeforeDrag = okhslHarness.conversionCount;

    act(() => {
      grant(0, 30);
      release(0, 90);
      grant(0, 150);
      release(0, 240);
    });
    expect(responderHarness.measurementCallCount).toBe(1);
    expect(responderHarness.measurementCallbacks).toHaveLength(1);

    act(() => {
      resolveNextMeasurement();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(okhslHarness.conversionCount).toBe(conversionsBeforeDrag);
    expect(responderHarness.measurementCallCount).toBe(2);
    expect(responderHarness.measurementCallbacks).toHaveLength(1);

    act(() => {
      resolveNextMeasurement();
    });

    expect(slider(container, LIGHTNESS_LABEL).dataset.accessibilityValue).toBe('80%');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(responderHarness.measurementCallbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a newer slider drag active when an old deferred release resolves', () => {
    responderHarness.deferMeasurements = true;
    const onChange = vi.fn();
    const { container } = render(<OkhslColorPicker value="#00ff00" onChange={onChange} />);
    const conversionsBeforeDrag = okhslHarness.conversionCount;

    act(() => {
      grant(0, 30);
      release(0, 90);
      grant(1, 60);
      // A late termination from the old responder must be as inert as its
      // deferred release once another channel owns the picker-wide gesture.
      terminate(0, 120);
    });

    expect(responderHarness.measurementCallCount).toBe(2);
    expect(responderHarness.measurementCallbacks).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      resolveNextMeasurement();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(okhslHarness.conversionCount).toBe(conversionsBeforeDrag);
    expect(responderHarness.measurementCallbacks).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      resolveNextMeasurement();
    });

    expect(slider(container, SATURATION_LABEL).dataset.accessibilityValue).toBe('20%');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(okhslHarness.conversionCount).toBe(conversionsBeforeDrag + 1);
    // The saturation update remains inside the active drag's ~30 fps
    // throttle. A stale lightness release would flush it immediately.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      terminate(1, 90);
    });

    expect(slider(container, SATURATION_LABEL).dataset.accessibilityValue).toBe('30%');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
