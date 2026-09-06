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

type HitSlop = number | { top?: number; bottom?: number; left?: number; right?: number };
type PressProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; disabled?: boolean };
  disabled?: boolean;
  // An object here is the point, not an incidental: the frame-edit pair's slop is
  // asymmetric so it can never reach up into the chip row above it.
  hitSlop?: HitSlop;
  testID?: string;
};
type ViewProps = { children?: ReactNode; testID?: string; accessibilityLabel?: string };

vi.mock('react-native', () => {
  const View = ({ children, testID, accessibilityLabel }: ViewProps) =>
    createElement('div', { 'data-testid': testID, 'data-label': accessibilityLabel }, children);
  const Pressable = ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
    disabled,
    hitSlop,
    testID,
  }: PressProps) =>
    createElement(
      'button',
      {
        'data-testid': testID,
        'data-label': accessibilityLabel,
        'data-selected': accessibilityState?.selected == null ? undefined : String(accessibilityState.selected),
        'data-hit-slop': typeof hitSlop === 'object' ? JSON.stringify(hitSlop) : hitSlop,
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
  opacity: { subtle: 0.7, peek: 0.62, disabled: 0.5 },
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
    editPair: container.querySelector('[data-testid="playback-frame-edit-pair"]') as HTMLElement | null,
    addFrame: container.querySelector('[data-testid="playback-add-frame"]') as HTMLButtonElement | null,
    deleteFrame: container.querySelector('[data-testid="playback-delete-frame"]') as HTMLButtonElement | null,
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
  const frameEditing = { onAddFrame: vi.fn(), onDeleteFrame: vi.fn() };

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

  it('keeps add and remove out of the scroller, at any frame count', () => {
    // Twice QA-declined before this: once for a control that scrolled out of
    // view, once for one that was a bare unlabelled glyph. The pair is a glyph
    // now by design, so the label has to survive in the accessible name — and
    // the pair must never enter the scroller, whatever the frame count.
    const { addFrame, deleteFrame, scroller, editPair } = renderControls({ frameCount: 12, frameEditing });

    expect(editPair).toBeTruthy();
    expect(scroller).toBeTruthy();
    expect(scroller?.contains(addFrame)).toBe(false);
    expect(scroller?.contains(deleteFrame)).toBe(false);
    expect(addFrame?.getAttribute('data-label')).toBe('mobile.create.playback.addFrame');
    expect(deleteFrame?.getAttribute('data-label')).toBe('mobile.create.playback.deleteFrameA11y:1/12');
  });

  it('adds a frame from the pair', () => {
    const onAddFrame = vi.fn();
    const { addFrame } = renderControls({ frameEditing: { onAddFrame, onDeleteFrame: vi.fn() } });

    addFrame?.click();
    expect(onAddFrame).toHaveBeenCalledTimes(1);
  });

  it('removes the frame the transport is sitting on', () => {
    const onDeleteFrame = vi.fn();
    const { deleteFrame } = renderControls({
      frameCount: 4,
      frameIndex: 2,
      frameEditing: { onAddFrame: vi.fn(), onDeleteFrame },
    });

    // The ordinal AND the total are in the label: this is the only text the
    // control has, and "delete frame 3" without "of 4" does not tell a blind
    // setter whether the route is about to lose its last frame.
    expect(deleteFrame?.getAttribute('data-label')).toBe('mobile.create.playback.deleteFrameA11y:3/4');
    deleteFrame?.click();
    expect(onDeleteFrame).toHaveBeenCalledTimes(1);
  });

  it('disables remove at one frame rather than hiding it', () => {
    // Hiding it would reflow the capsule from 88 to 44 the moment a second frame
    // appears, walking the whole transport row sideways under the thumb.
    const { deleteFrame, addFrame } = renderControls({ frameCount: 1, frameEditing });

    expect(deleteFrame).toBeTruthy();
    expect(deleteFrame?.disabled).toBe(true);
    expect(deleteFrame?.getAttribute('data-label')).toBe('mobile.create.playback.deleteFrameBlocked');
    expect(addFrame?.disabled).toBeFalsy();
  });

  it('never lets either half of the pair reach up into the chip row', () => {
    // The chips sit 8dp above with 6dp of their own slop. A chip tap that slid
    // down into a frame command is the one mis-tap this layout could cause, so
    // the pair's slop is asymmetric: down and outwards, never up, and never into
    // each other.
    const { addFrame, deleteFrame } = renderControls({ frameCount: 4, frameEditing });

    expect(addFrame?.getAttribute('data-hit-slop')).toBe('{"top":0,"bottom":6,"left":4,"right":0}');
    expect(deleteFrame?.getAttribute('data-hit-slop')).toBe('{"top":0,"bottom":6,"left":0,"right":4}');
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

  it('moves the wall-state chip to the strip, keeping the pair in its slot', () => {
    // The reader shows "On the wall" in the transport row's left slot. In edit
    // mode that slot is permanently the add/remove pair, so the chip takes the
    // trailing edge of the strip — the space the old Add frame button vacated.
    const { container, chips, editPair, strip } = renderControls({
      frameCount: 3,
      frameEditing,
      wallStateLabel: 'On the wall',
    });

    expect(container.textContent).toContain('On the wall');
    expect(chips).toHaveLength(3);
    expect(editPair).toBeTruthy();
    expect(strip?.textContent).toContain('On the wall');
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
