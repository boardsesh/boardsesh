// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';

// PlaybackControls is mounted by TWO callers — the play drawer and the create
// drawer — and only the second one passes the creator props. The first case here
// is the regression guard for that: with `frameEditing` absent the card must keep
// rendering the reader's `1 / 4` counter and grow no strip, or the play drawer
// silently inherits an editor.

const hapticSelection = vi.hoisted(() => vi.fn());
const scrollTo = vi.hoisted(() => vi.fn());

type PressProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; disabled?: boolean };
  disabled?: boolean;
  hitSlop?: number;
};
type ViewProps = { children?: ReactNode; testID?: string; accessibilityLabel?: string };

vi.mock('react-native', () => {
  const View = ({ children, testID, accessibilityLabel }: ViewProps) =>
    createElement('div', { 'data-testid': testID, 'data-label': accessibilityLabel }, children);
  const Pressable = ({ children, onPress, accessibilityLabel, accessibilityState, disabled, hitSlop }: PressProps) =>
    createElement(
      'button',
      {
        'data-label': accessibilityLabel,
        'data-selected': accessibilityState?.selected == null ? undefined : String(accessibilityState.selected),
        'data-hit-slop': hitSlop,
        disabled,
        onClick: onPress,
      },
      children,
    );
  const ScrollView = forwardRef<{ scrollTo: typeof scrollTo }, { children?: ReactNode }>(function ScrollView(
    { children },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollTo }), []);
    return createElement('div', { 'data-node': 'scroller' }, children);
  });
  return {
    View,
    Pressable,
    ScrollView,
    StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  };
});

vi.mock('react-native-reanimated', () => {
  const AnimatedView = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const fade = { duration: () => ({}) };
  return {
    default: {
      View: AnimatedView,
      // The animated wrappers here only need to render; the press-scale springs
      // they drive are UI-thread decoration.
      createAnimatedComponent: <P,>(Component: (props: P) => ReactNode) => Component,
    },
    FadeIn: fade,
    FadeOut: fade,
    useAnimatedStyle: () => ({}),
    useSharedValue: (initial: number) => ({ value: initial, get: () => initial, set: () => {} }),
    withSpring: (value: number) => value,
    withTiming: (value: number) => value,
    withSequence: (value: number) => value,
    runOnJS: <A extends unknown[]>(fn: (...args: A) => void) => fn,
  };
});

vi.mock('react-native-gesture-handler', () => {
  const chainable: Record<string, () => unknown> = {};
  const gesture = new Proxy(chainable, { get: () => () => gesture });
  return {
    Gesture: { Pan: () => gesture, Tap: () => gesture, Race: () => gesture },
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolating (rather than the usual identity `t`) so the per-frame chip
    // labels are distinguishable — they all share one key.
    t: (key: string, options?: { index?: number; total?: number }) =>
      options ? `${key}:${options.index}/${options.total}` : key,
  }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, size }: { name?: string; size?: number }) =>
    createElement('span', { 'data-icon': name, 'data-size': size }),
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    variant,
    minHeight,
  }: {
    title?: string;
    onPress?: () => void;
    variant?: string;
    minHeight?: number;
  }) =>
    createElement(
      'button',
      { 'data-title': title, 'data-variant': variant, 'data-min-height': minHeight, onClick: onPress },
      title,
    ),
}));
vi.mock('../../GlassCluster', () => ({
  GlassCluster: ({ children, spacing }: { children?: ReactNode; spacing?: number }) =>
    createElement('div', { 'data-node': 'cluster', 'data-spacing': spacing }, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      tertiaryBackground: '#F2F2F7',
      label: '#000000',
      secondaryLabel: '#3C3C4399',
      tertiaryLabel: '#3C3C434D',
      fill: '#78788033',
    },
    brandColors: { primary: '#6D28D9' },
    radii: { button: 10 },
  }),
}));
vi.mock('../../../lib/haptics', () => ({
  hapticSelection,
  hapticLight: vi.fn(),
  hapticSuccess: vi.fn(),
}));
vi.mock('../../../theme/colors', () => ({
  brandColors: { primary: '#6D28D9' },
  withAlpha: (color: string, alpha: number) => `${color}/${alpha}`,
}));
vi.mock('../../../theme/layout', () => ({ glassSize: { inline: 44, mini: 32 } }));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { separator: '#C6C6C8', white: '#FFFFFF' },
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12, full: 9999 },
}));
vi.mock('../../../theme/animations', () => ({
  springs: { snappy: {}, bouncy: {} },
  timing: { instant: 100, fast: 200 },
}));

import { PlaybackControls } from '../PlaybackControls';

type ControlsProps = Parameters<typeof PlaybackControls>[0];

function renderControls(overrides: Partial<ControlsProps> = {}) {
  const onSeek = vi.fn();
  const onSpeedChange = vi.fn();
  const onPaceChange = vi.fn();
  const onAddFrame = vi.fn();
  const { container } = render(
    createElement(PlaybackControls, {
      frameIndex: 0,
      frameCount: 4,
      isPlaying: false,
      speed: 1,
      paceMs: 750,
      onPlay: vi.fn(),
      onPause: vi.fn(),
      onSeek,
      onSpeedChange,
      onPaceChange,
      ...overrides,
    } as ControlsProps),
  );
  const strip = container.querySelector('[data-testid="playback-frame-strip"]') as HTMLElement | null;
  const chips = Array.from(container.querySelectorAll('[data-label^="playView.frameCounterA11y:"]')).filter(
    (node) => node.tagName === 'BUTTON',
  ) as HTMLButtonElement[];
  return {
    container,
    onSeek,
    onSpeedChange,
    onPaceChange,
    onAddFrame,
    strip,
    chips,
    scroller: container.querySelector('[data-node="scroller"]') as HTMLElement | null,
    addFrame: container.querySelector('[data-title="mobile.create.playback.addFrame"]') as HTMLButtonElement | null,
    pill: container.querySelector('[data-label^="playView.speed,"]') as HTMLButtonElement | null,
  };
}

beforeEach(() => {
  hapticSelection.mockClear();
  scrollTo.mockClear();
});

describe('PlaybackControls — play drawer (no creator props)', () => {
  it('keeps the reader counter and grows no frame strip', () => {
    const { container, strip, chips, addFrame } = renderControls({ frameIndex: 0, frameCount: 4 });

    expect(strip).toBeNull();
    expect(chips).toHaveLength(0);
    expect(addFrame).toBeNull();
    expect(container.textContent).toContain('1 / 4');
  });

  it('shows the multiplier, not seconds, and drives onSpeedChange', () => {
    const { pill, onSpeedChange, onPaceChange } = renderControls({ speed: 1, paceMs: 750 });

    expect(pill?.getAttribute('data-label')).toBe('playView.speed, 1×');
    pill?.click();
    // 1× → the next preset above it.
    expect(onSpeedChange).toHaveBeenCalledWith(1.5);
    expect(onPaceChange).not.toHaveBeenCalled();
  });

  it('hands prev/play/next to one cluster at a single height', () => {
    // GlassCluster only fuses members that share a height, so the demotion from
    // a 42pt hero glyph to a 24pt one inside a 44dp box is load-bearing.
    const { container } = renderControls();
    const cluster = container.querySelector('[data-node="cluster"]');

    expect(cluster?.getAttribute('data-spacing')).toBe('8');
    const glyphSizes = Array.from(cluster?.querySelectorAll('[data-icon]') ?? []).map((node) =>
      node.getAttribute('data-size'),
    );
    expect(glyphSizes).toEqual(['20', '24', '20']);
  });
});

describe('PlaybackControls — creator frame strip', () => {
  const frameEditing = { onAddFrame: vi.fn() };

  it('replaces the counter with one chip per frame', () => {
    const { container, strip, chips } = renderControls({ frameCount: 4, frameIndex: 1, frameEditing });

    expect(strip).toBeTruthy();
    expect(chips).toHaveLength(4);
    expect(chips.map((chip) => chip.textContent)).toEqual(['1', '2', '3', '4']);
    // The counter is gone — the strip IS the position readout now.
    expect(container.textContent).not.toContain('1 / 4');
    expect(chips[1]?.getAttribute('data-selected')).toBe('true');
    expect(chips[0]?.getAttribute('data-selected')).toBe('false');
  });

  it('pins Add frame outside the scroller as a labelled chip', () => {
    // Twice QA-declined: once as a bare glyph, once for scrolling out of view.
    const { addFrame, scroller } = renderControls({ frameCount: 12, frameEditing });

    expect(addFrame).toBeTruthy();
    expect(addFrame?.textContent).toBe('mobile.create.playback.addFrame');
    expect(scroller).toBeTruthy();
    expect(scroller?.contains(addFrame)).toBe(false);
    // Floored at 44 on its own: a native Button has no hitSlop to reach the
    // touch target with, unlike the 32dp chips beside it. That is what makes the
    // strip row 44 and the card's reserve 128dp.
    expect(addFrame?.getAttribute('data-min-height')).toBe('44');
    expect(addFrame?.getAttribute('data-variant')).toBe('tonal');
  });

  it('adds a frame from the pinned chip', () => {
    const onAddFrame = vi.fn();
    const { addFrame } = renderControls({ frameEditing: { onAddFrame } });

    addFrame?.click();
    expect(onAddFrame).toHaveBeenCalledTimes(1);
  });

  it('seeks to the tapped frame', () => {
    const { chips, onSeek } = renderControls({ frameCount: 4, frameIndex: 0, frameEditing });

    chips[2]?.click();
    expect(onSeek).toHaveBeenCalledWith(2);
    chips[0]?.click();
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });

  it('keeps every chip at the 44dp touch floor via slop', () => {
    // 32dp chip + 6dp each edge. The row cannot grow — the card height is a
    // contract CreateDrawer reserves against.
    const { chips } = renderControls({ frameCount: 3, frameEditing });
    expect(chips.every((chip) => chip.getAttribute('data-hit-slop') === '6')).toBe(true);
  });

  it('still shows the wall-state chip in place of the counter slot', () => {
    const { container, chips } = renderControls({ frameCount: 3, frameEditing, wallStateLabel: 'On the wall' });

    expect(container.textContent).toContain('On the wall');
    expect(chips).toHaveLength(3);
  });
});

describe('PlaybackControls — seconds-per-frame pill', () => {
  it('renders the authored pace, trimming a trailing zero', () => {
    expect(renderControls({ paceMs: 800, paceUnit: 'seconds' }).pill?.getAttribute('data-label')).toBe(
      'playView.speed, 0.8s',
    );
    expect(renderControls({ paceMs: 3000, paceUnit: 'seconds' }).pill?.getAttribute('data-label')).toBe(
      'playView.speed, 3s',
    );
    expect(renderControls({ paceMs: 1500, paceUnit: 'seconds' }).pill?.getAttribute('data-label')).toBe(
      'playView.speed, 1.5s',
    );
  });

  it('cycles the pace presets on tap and reports milliseconds', () => {
    const fromDefault = renderControls({ paceMs: 800, paceUnit: 'seconds' });
    fromDefault.pill?.click();
    expect(fromDefault.onPaceChange).toHaveBeenCalledWith(1500);

    const fromTop = renderControls({ paceMs: 5000, paceUnit: 'seconds' });
    fromTop.pill?.click();
    // Past the slowest preset it wraps to the fastest rather than sticking.
    expect(fromTop.onPaceChange).toHaveBeenCalledWith(500);
  });

  it('cycles back into the legal range from a pace outside it', () => {
    // A climb saved with a nonsense pace (or one authored before the range
    // existed) must not strand the pill: the next tap lands on a real preset.
    const tooFast = renderControls({ paceMs: 50, paceUnit: 'seconds' });
    tooFast.pill?.click();
    expect(tooFast.onPaceChange).toHaveBeenCalledWith(500);

    const tooSlow = renderControls({ paceMs: 60_000, paceUnit: 'seconds' });
    tooSlow.pill?.click();
    expect(tooSlow.onPaceChange).toHaveBeenCalledWith(500);
  });

  it('leaves onSpeedChange alone in seconds mode', () => {
    const { pill, onSpeedChange } = renderControls({ paceMs: 800, paceUnit: 'seconds' });
    pill?.click();
    expect(onSpeedChange).not.toHaveBeenCalled();
  });
});
