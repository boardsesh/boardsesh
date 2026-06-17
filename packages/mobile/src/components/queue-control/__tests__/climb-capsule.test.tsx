// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode, type CSSProperties } from 'react';
import type { ClimbQueueItem, Climb } from '@boardsesh/queue';

// --- hoisted spies so individual tests can reconfigure provider state ---------
const queue = vi.hoisted(() => ({
  state: {
    currentClimbQueueItem: null as ClimbQueueItem | null,
    queue: [] as ClimbQueueItem[],
  },
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
}));
const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn() }));

// --- RN surface: View → div ---------------------------------------------------
// Forward testID and the resolved backgroundColor so a test can assert the leading
// grade-accent stripe paints the current climb's grade colour.
function backgroundOf(style: unknown): string {
  const entries = (Array.isArray(style) ? style.flat(Infinity) : [style]) as Array<Record<string, unknown> | undefined>;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry && typeof entry === 'object' && typeof entry.backgroundColor === 'string') return entry.backgroundColor;
  }
  return '';
}
type LayoutHandler = (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    style,
    onLayout,
  }: {
    children?: ReactNode;
    testID?: string;
    style?: unknown;
    onLayout?: LayoutHandler;
  }) => {
    // jsdom never lays out, so simulate the swipe viewport being measured —
    // otherwise width stays 0, canPeek is false, and the peek slots never render.
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 400, height: 48 } } });
    }, [onLayout]);
    return createElement('div', { 'data-testid': testID, 'data-bg': backgroundOf(style) }, children);
  },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: {},
    hairlineWidth: 1,
  },
}));

// The tap hook wraps its open handler in runOnJS — return it as-is.
vi.mock('react-native-reanimated', () => ({
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
}));

// GestureDetector just renders its child; Gesture is a fluent no-op builder so
// the worklet wiring in the component constructs without a native runtime.
vi.mock('react-native-gesture-handler', () => {
  const chainable: Record<string, () => unknown> = {};
  const builder = new Proxy(chainable, { get: () => () => builder });
  return {
    GestureDetector: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-gesture': 'true' }, children),
    Gesture: { Tap: () => builder, Pan: () => builder, Exclusive: () => builder },
  };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// useAccessoryClimbTap builds a preview queue item via climbToQueueItem, which
// pulls expo-crypto's randomUUID — stub it so the native module isn't loaded.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));

// getGradeColor returns a distinct hue for V6 so we can assert the grade text
// carries the grade colour (not a generic white-on-pill style).
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: (difficulty: string | null | undefined) => (difficulty === 'V6' ? '#FF0000' : undefined),
  DEFAULT_GRADE_COLOR: '#808080',
}));

// Text → span exposing colour: prefer the explicit `color` prop, else the
// merged `style.color`, so a test can read whichever the component used.
type TextMockProps = {
  children?: ReactNode;
  color?: string;
  style?: CSSProperties | Array<CSSProperties | undefined | false | null>;
  variant?: string;
};
function readColor(props: TextMockProps): string {
  if (props.color != null) return props.color;
  const styles = Array.isArray(props.style) ? props.style : [props.style];
  for (let i = styles.length - 1; i >= 0; i -= 1) {
    const entry = styles[i];
    if (entry && typeof entry === 'object' && 'color' in entry && entry.color != null) {
      return String((entry as { color: unknown }).color);
    }
  }
  return '';
}
vi.mock('../../Text', () => ({
  Text: (props: TextMockProps) =>
    createElement('span', { 'data-text': 'true', 'data-color': readColor(props) }, props.children),
}));

vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ tintColor }: { tintColor?: string }) =>
    createElement('div', { 'data-glass': 'true', 'data-tint': tintColor ?? '' }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111111', separator: '#cccccc', elevatedSurface: '#f0f0f0' },
  }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: queue.state, nextClimb: queue.nextClimb, previousClimb: queue.previousClimb }),
  useActiveClimbQueueItemUuid: () => queue.state.currentClimbQueueItem?.uuid ?? null,
}));

vi.mock('../../../hooks/use-actively-climbing', () => ({ useIsActivelyClimbing: () => false }));
vi.mock('../../../lib/accessory-dismiss-store', () => ({ dismissAccessory: vi.fn() }));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer, boardConfig: null }),
}));

// The board thumbnail pulls in board-details/native render deps; the capsule
// only renders it when boardConfig is set (null here), so stub it out.
vi.mock('../AccessoryClimbThumbnail', () => ({ AccessoryClimbThumbnail: () => null }));

// formatGrade prefixes so the displayed grade is distinguishable from the raw
// difficulty key used for colour lookup.
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGrade: (difficulty: string | null | undefined) => (difficulty ? `${difficulty} 6C` : null),
  }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));

vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string) => `${color}29` }));
vi.mock('../../../theme/layout', () => ({ TOOLBAR_CAPSULE_HEIGHT: 52, TOOLBAR_CAPSULE_MAX_WIDTH: 260 }));
vi.mock('../../../theme/tokens', () => ({
  shadows: { sm: {} },
  spacing: { 1: 4, 2: 8, 4: 16 },
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
// AccessoryBarSurface (the capsule background) resolves the surface via this —
// force the glass branch so the GlassSurface mock renders and `[data-glass]`
// assertions hold.
vi.mock('../../../hooks/use-effective-surface-mode', () => ({ useEffectiveSurfaceMode: () => 'glass' }));

// Board-presence source flip: default identity passthrough (flag off / no wall
// feed) so the capsule renders the local queue head exactly as today.
vi.mock('../use-wall-or-queue-climb', () => ({
  useWallOrQueueCurrentClimb: (localClimb: unknown) => localClimb,
}));

import { ClimbCapsule } from '../ClimbCapsule';

function makeClimb(over: Partial<Climb> = {}): Climb {
  return {
    uuid: 'c1',
    setter_username: 'someone',
    name: 'The Crimp Ladder',
    frames: '',
    angle: 40,
    ascensionist_count: 10,
    difficulty: 'V6',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    ...over,
  };
}

function makeItem(climb: Climb): ClimbQueueItem {
  return { uuid: climb.uuid, climb };
}

describe('ClimbCapsule', () => {
  beforeEach(() => {
    queue.state.currentClimbQueueItem = null;
    queue.state.queue = [];
    drawer.openPlayDrawer.mockClear();
    queue.nextClimb.mockClear();
    queue.previousClimb.mockClear();
  });

  it('renders nothing when there is no current climb', () => {
    const { container } = render(<ClimbCapsule />);
    expect(container.querySelector('[data-text]')).toBeNull();
    // No glass surface either — the whole capsule short-circuits.
    expect(container.querySelector('[data-glass]')).toBeNull();
  });

  it('renders the climb name when a climb is active', () => {
    const item = makeItem(makeClimb({ name: 'The Crimp Ladder' }));
    queue.state.currentClimbQueueItem = item;
    queue.state.queue = [item];

    const { container } = render(<ClimbCapsule />);
    expect(container.textContent).toContain('The Crimp Ladder');
    expect(container.querySelector('[data-glass]')).not.toBeNull();
  });

  it('colorizes the grade text with the grade colour (not a white-on-pill style)', () => {
    const item = makeItem(makeClimb({ difficulty: 'V6' }));
    queue.state.currentClimbQueueItem = item;
    queue.state.queue = [item];

    const { container } = render(<ClimbCapsule />);

    // The grade text reads "V6 6C" (formatGrade output) and must carry the
    // grade hue #FF0000, applied via style.color — the recent change moving the
    // grade to colorized text on the right, matching the list rows.
    const texts = Array.from(container.querySelectorAll('[data-text]'));
    const gradeNode = texts.find((node) => (node.textContent ?? '').includes('6C'));
    expect(gradeNode).toBeTruthy();
    expect(gradeNode?.getAttribute('data-color')).toBe('#FF0000');

    // It is NOT white (the old on-pill treatment) and NOT the neutral label.
    expect(gradeNode?.getAttribute('data-color')).not.toBe('#FFFFFF');
    expect(gradeNode?.getAttribute('data-color')).not.toBe('#111111');

    // The name keeps the neutral label colour, proving only the grade is hued.
    const nameNode = texts.find((node) => (node.textContent ?? '').includes('Crimp'));
    expect(nameNode?.getAttribute('data-color')).toBe('#111111');
  });

  it('falls back to the default grade colour for an uncolored grade', () => {
    const item = makeItem(makeClimb({ difficulty: 'V99', name: 'Mystery' }));
    queue.state.currentClimbQueueItem = item;
    queue.state.queue = [item];

    const { container } = render(<ClimbCapsule />);
    const gradeNode = Array.from(container.querySelectorAll('[data-text]')).find((node) =>
      (node.textContent ?? '').includes('6C'),
    );
    expect(gradeNode?.getAttribute('data-color')).toBe('#808080');
  });

  it('keeps the glass neutral — no grade-hued wash (the grade rides the text only)', () => {
    const item = makeItem(makeClimb({ difficulty: 'V6' }));
    queue.state.currentClimbQueueItem = item;
    queue.state.queue = [item];

    const { container } = render(<ClimbCapsule />);
    // No tint passed to the glass — the capsule background is plain frosted glass.
    expect(container.querySelector('[data-glass]')?.getAttribute('data-tint')).toBe('');
  });

  it('wires openPlayDrawer for tap-to-open (drawer-open behavior; tap worklet not driven in jsdom)', () => {
    // We cannot fire the RNGH Tap worklet under jsdom, so the wired callback can't
    // be reached here; instead assert the render path is healthy and that no
    // openPlayDrawer call fires without a tap.
    const item = makeItem(makeClimb());
    queue.state.currentClimbQueueItem = item;
    queue.state.queue = [item];

    render(<ClimbCapsule />);
    // No tap fired → no call yet. (Documents the jsdom gesture limitation.)
    expect(drawer.openPlayDrawer).not.toHaveBeenCalled();
  });

  it('marks the docked bar with a leading grade-colour accent stripe, keeping text neutral', () => {
    // The docked Material bar stays on a neutral surface: the grade rides a vivid
    // leading accent stripe + the colorized grade number, NOT a full coloured fill,
    // so the name stays the neutral label and the grade keeps its hue.
    const item = makeItem(makeClimb({ difficulty: 'V6', name: 'The Crimp Ladder' }));
    queue.state.currentClimbQueueItem = item;
    queue.state.queue = [item];

    const { container } = render(<ClimbCapsule surfaceTreatment="docked" />);

    const accent = container.querySelector('[data-testid="grade-accent"]');
    expect(accent).not.toBeNull();
    expect(accent?.getAttribute('data-bg')).toBe('#FF0000');

    const texts = Array.from(container.querySelectorAll('[data-text]'));
    const gradeNode = texts.find((node) => (node.textContent ?? '').includes('6C'));
    const nameNode = texts.find((node) => (node.textContent ?? '').includes('Crimp'));
    expect(gradeNode?.getAttribute('data-color')).toBe('#FF0000');
    expect(nameNode?.getAttribute('data-color')).toBe('#111111');
  });

  it('uses the gray fallback for the accent stripe of an unknown grade', () => {
    const item = makeItem(makeClimb({ difficulty: 'V99', name: 'Mystery' }));
    queue.state.currentClimbQueueItem = item;
    queue.state.queue = [item];

    const { container } = render(<ClimbCapsule surfaceTreatment="docked" />);
    expect(container.querySelector('[data-testid="grade-accent"]')?.getAttribute('data-bg')).toBe('#808080');
  });

  it('omits the accent stripe on the non-docked floating capsule', () => {
    // The stripe is a docked-bar treatment; the floating capsule keeps its plain pill.
    const item = makeItem(makeClimb({ difficulty: 'V6', name: 'The Crimp Ladder' }));
    queue.state.currentClimbQueueItem = item;
    queue.state.queue = [item];

    const { container } = render(<ClimbCapsule />);
    expect(container.querySelector('[data-testid="grade-accent"]')).toBeNull();
  });

  it('renders a single climb label (no peek neighbours)', () => {
    // The swipe carousel + peeking neighbours were removed; the capsule shows the
    // current climb only. Exactly one name node renders.
    const item = makeItem(makeClimb({ name: 'Lonely Route' }));
    queue.state.currentClimbQueueItem = item;
    queue.state.queue = [item];

    const { container } = render(<ClimbCapsule />);
    const nameNodes = Array.from(container.querySelectorAll('[data-text]')).filter((node) =>
      (node.textContent ?? '').includes('Lonely Route'),
    );
    expect(nameNodes).toHaveLength(1);
  });
});
