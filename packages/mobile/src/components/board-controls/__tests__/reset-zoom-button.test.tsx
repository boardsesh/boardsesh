// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, useEffect, useRef, type ReactNode } from 'react';

const MEASURED_ROW_WIDTH = 118;
const COLLAPSED = 32;

// The two shared values the component creates, in order: [opacity, width].
const sharedValues = vi.hoisted(() => [] as { value: number }[]);

type PressProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
type ViewProps = { children?: ReactNode; onLayout?: (event: unknown) => void; style?: unknown };
type WrapperProps = {
  children?: ReactNode;
  pointerEvents?: string;
  accessibilityElementsHidden?: boolean;
  importantForAccessibility?: string;
};

vi.mock('react-native', () => ({
  // Fires onLayout the way a real host does, so the component can measure the
  // extended pill; without it the button could never leave its collapsed width.
  View: ({ children, onLayout }: ViewProps) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: MEASURED_ROW_WIDTH, height: COLLAPSED } } });
    }, [onLayout]);
    return createElement('div', null, children);
  },
  Pressable: ({ children, onPress, accessibilityLabel }: PressProps) =>
    createElement('button', { onClick: onPress, 'data-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios },
  PlatformColor: (name: string) => name,
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, pointerEvents, accessibilityElementsHidden, importantForAccessibility }: WrapperProps) =>
      createElement(
        'div',
        {
          'data-pointer-events': pointerEvents,
          'data-a11y-hidden': accessibilityElementsHidden ? 'true' : 'false',
          'data-a11y-important': importantForAccessibility,
        },
        children,
      ),
  },
  // Stable per component instance, like the real hook. A mock that returns a
  // fresh object each render hands the effects one object and the assertions
  // another, which reads as "the animation never ran".
  useSharedValue: (initial: number) => {
    const ref = useRef<{ value: number } | null>(null);
    if (ref.current === null) {
      ref.current = { value: initial };
      sharedValues.push(ref.current);
    }
    return ref.current;
  },
  useAnimatedStyle: (build: () => unknown) => build(),
  // Timings land immediately, so the value reflects the target being animated to.
  withTiming: (target: number) => target,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// The one-shot marker behind the label. Defaults to "never used", so the hint is
// live unless a test says otherwise.
const hint = vi.hoisted(() => ({ used: false, marked: 0 }));
vi.mock('../../../lib/reset-zoom-hint', () => ({
  hasUsedResetZoom: () => Promise.resolve(hint.used),
  markResetZoomUsed: () => {
    hint.marked += 1;
    return Promise.resolve();
  },
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name?: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-label-text': 'true' }, children),
}));

import { ResetZoomButton } from '../ResetZoomButton';

const wrapper = (container: HTMLElement) => container.querySelector('[data-pointer-events]') as HTMLElement;
const widthValue = () => sharedValues[1]?.value;

describe('ResetZoomButton', () => {
  beforeEach(() => {
    sharedValues.length = 0;
    hint.used = false;
    hint.marked = 0;
    // Only the timer APIs this component uses. Faking the whole clock stalls
    // React's scheduler, so the onLayout-driven re-render that carries the
    // measured width never lands and the button looks stuck collapsed.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is inert and out of the a11y tree while hidden', () => {
    // Faded out is not just invisible: a control left in the a11y tree is a
    // target VoiceOver lands on that does nothing.
    const { container } = render(createElement(ResetZoomButton, { visible: false, onPress: vi.fn() }));
    expect(wrapper(container).getAttribute('data-pointer-events')).toBe('none');
    expect(wrapper(container).getAttribute('data-a11y-hidden')).toBe('true');
    expect(wrapper(container).getAttribute('data-a11y-important')).toBe('no-hide-descendants');
  });

  it('is tappable and announced while visible', () => {
    const onPress = vi.fn();
    const { container } = render(createElement(ResetZoomButton, { visible: true, onPress }));
    expect(wrapper(container).getAttribute('data-pointer-events')).toBe('auto');

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('data-label')).toBe('board.resetZoom');
    button.click();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('extends to show the label on zoom, then collapses to the glyph after 3s', async () => {
    // The point of the label: an icon alone does not say "reset zoom", but a
    // label that keeps coming back is the footprint that covered holds.
    render(createElement(ResetZoomButton, { visible: true, onPress: vi.fn() }));
    await act(async () => {});
    expect(widthValue()).toBe(MEASURED_ROW_WIDTH);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(widthValue()).toBe(COLLAPSED);
  });

  it('never shows the label again once the control has been used', async () => {
    hint.used = true;
    render(createElement(ResetZoomButton, { visible: true, onPress: vi.fn() }));
    await act(async () => {});
    expect(widthValue()).toBe(COLLAPSED);
  });

  it('marks the control used on the first press, once', async () => {
    // Written on PRESS, not on display: reading the label is not the same as
    // having connected the glyph to the action.
    const { container } = render(createElement(ResetZoomButton, { visible: true, onPress: vi.fn() }));
    await act(async () => {});
    const button = container.querySelector('button') as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    expect(hint.marked).toBe(1);
    expect(widthValue()).toBe(COLLAPSED);

    await act(async () => {
      button.click();
    });
    expect(hint.marked).toBe(1);
  });

  it('holds the hint collapsed until the marker has been read', () => {
    // The read is async. Extending first and snapping away on the answer would
    // read as a glitch, so an unknown marker stays collapsed.
    render(createElement(ResetZoomButton, { visible: true, onPress: vi.fn() }));
    expect(widthValue()).toBe(COLLAPSED);
  });

  it('stays collapsed while not zoomed', async () => {
    render(createElement(ResetZoomButton, { visible: false, onPress: vi.fn() }));
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(widthValue()).toBe(COLLAPSED);
  });

  it('carries the wording as text as well as the accessibility label', () => {
    const { container } = render(createElement(ResetZoomButton, { visible: true, onPress: vi.fn() }));
    expect(container.querySelector('[data-label-text="true"]')?.textContent).toBe('board.resetZoom');
    expect(container.querySelector('[data-icon="crop.free"]')).toBeTruthy();
  });
});
