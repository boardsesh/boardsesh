// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode, type CSSProperties } from 'react';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import type { BoardConfig } from '../../../providers/drawer-host-provider';

const queue = vi.hoisted(() => ({
  state: {
    currentClimbQueueItem: null as ClimbQueueItem | null,
    queue: [] as ClimbQueueItem[],
  },
  sessionId: null as string | null,
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
}));

const drawer = vi.hoisted(() => ({
  boardConfig: null as BoardConfig | null,
  openPlayDrawer: vi.fn(),
}));

const router = vi.hoisted(() => ({ navigate: vi.fn() }));
const route = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as string[] }));

const boardRender = vi.hoisted(() => ({
  boardWidth: 1080,
  boardHeight: 1920,
}));

// Injectable navigation result so tests can drive the suggestion-aware
// canNext/nextItem the component reads from computeNavigationStateWithSuggestions.
const nav = vi.hoisted(() => ({
  result: {
    canNext: false,
    canPrevious: false,
    nextItem: null as ClimbQueueItem | null,
    prevItem: null as ClimbQueueItem | null,
    remainingCount: 0,
  },
}));

function styleDataValue(styleValue: unknown): string {
  if (styleValue == null) return '';
  if (typeof styleValue === 'string' || typeof styleValue === 'number' || typeof styleValue === 'boolean') {
    return String(styleValue);
  }
  return JSON.stringify(styleValue);
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({
    children,
    style,
    accessibilityRole,
    accessibilityLabel,
    accessibilityActions,
    onLayout,
    testID,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
    testID?: string;
  }) => {
    // jsdom never lays out, so simulate the swipe viewport being measured —
    // otherwise width stays 0, canPeek is false, and the peek slots never render.
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 400, height: 48 } } });
    }, [onLayout]);
    const readStyleValue = (styleKey: string): unknown => {
      const styles = Array.isArray(style) ? style : [style];
      for (const styleEntry of styles) {
        if (
          styleEntry != null &&
          typeof styleEntry === 'object' &&
          Object.prototype.hasOwnProperty.call(styleEntry, styleKey)
        ) {
          return (styleEntry as Record<string, unknown>)[styleKey];
        }
      }
      return null;
    };
    const width = readStyleValue('width');
    const height = readStyleValue('height');
    const paddingRight = readStyleValue('paddingRight');
    const backgroundColor = readStyleValue('backgroundColor');
    const borderWidth = readStyleValue('borderWidth');
    const borderColor = readStyleValue('borderColor');
    const borderRadius = readStyleValue('borderRadius');
    const overflow = readStyleValue('overflow');
    return createElement(
      'div',
      {
        'data-width': styleDataValue(width),
        'data-height': styleDataValue(height),
        'data-padding-right': styleDataValue(paddingRight),
        'data-background-color': styleDataValue(backgroundColor),
        'data-border-width': styleDataValue(borderWidth),
        'data-border-color': styleDataValue(borderColor),
        'data-border-radius': styleDataValue(borderRadius),
        'data-overflow': styleDataValue(overflow),
        'data-role': accessibilityRole ?? '',
        'data-label': accessibilityLabel ?? '',
        'data-actions': Array.isArray(accessibilityActions)
          ? accessibilityActions.map((action) => action.name).join(',')
          : '',
        ...(testID ? { 'data-testid': testID } : {}),
      },
      children,
    );
  },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
  },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedStyle: () => ({}),
  useDerivedValue: () => ({ value: 0 }),
  useSharedValue: (initial: number) => ({ value: initial }),
}));

vi.mock('react-native-gesture-handler', () => {
  const chainable: Record<string, () => unknown> = {};
  const builder = new Proxy(chainable, { get: () => () => builder });
  return {
    GestureDetector: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-gesture': 'true' }, children),
    Gesture: { Tap: () => builder, Pan: () => builder, Race: () => builder },
  };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@boardsesh/play-view', () => ({
  computePeekOffset: () => 0,
  computeNavigationStateWithSuggestions: () => nav.result,
}));

type TextMockProps = {
  children?: ReactNode;
  color?: string;
  variant?: string;
  style?: CSSProperties | Array<CSSProperties | undefined | false | null>;
};

function readTextStyleValue(props: TextMockProps, styleKey: keyof CSSProperties): string {
  const styles = Array.isArray(props.style) ? props.style : [props.style];
  for (let styleIndex = styles.length - 1; styleIndex >= 0; styleIndex -= 1) {
    const styleEntry = styles[styleIndex];
    if (styleEntry && typeof styleEntry === 'object' && styleKey in styleEntry && styleEntry[styleKey] != null) {
      return String(styleEntry[styleKey]);
    }
  }
  return '';
}

function readColor(props: TextMockProps): string {
  return props.color ?? readTextStyleValue(props, 'color');
}

vi.mock('../../Text', () => ({
  Text: (props: TextMockProps) =>
    createElement(
      'span',
      {
        'data-text': 'true',
        'data-color': readColor(props),
        'data-font-weight': readTextStyleValue(props, 'fontWeight'),
        'data-variant': props.variant ?? '',
      },
      props.children,
    ),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111111' },
    brandColors: { primaryFill: '#6D28D9' },
  }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({
    state: queue.state,
    nextClimb: queue.nextClimb,
    previousClimb: queue.previousClimb,
  }),
  useQueueSessionId: () => ({ sessionId: queue.sessionId }),
  usePlaylistSuggestionSource: () => null,
  // Default to driver (not preview-only); these tests encode the bar's wiring,
  // not party gating — that is covered in use-queue-carousel.test.tsx.
  useIsPartyPreviewOnly: () => false,
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardConfig: drawer.boardConfig, openPlayDrawer: drawer.openPlayDrawer }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => router,
  useSegments: () => route.segments,
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (difficulty: string | null | undefined) => difficulty }),
}));

vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticSelection: vi.fn() }));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 10: 40 },
  borderRadius: { md: 8 },
}));

vi.mock('../../../theme/layout', () => ({
  glassSize: { standard: 48, inline: 44 },
}));

vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({
    boardWidth: boardRender.boardWidth,
    boardHeight: boardRender.boardHeight,
    backgroundImageKeys: ['kilter/product_sizes_layouts_sets/36-1.webp'],
    holdsData: [],
  }),
}));

// The accessory thumbnail renders through BoardImageNative (the rasterized
// native-PNG path). The mock surfaces the fitted box dimensions (width/height
// from `style`), the rounding/clipping it applies, and the mirror flag so the
// aspect-fit + mirroring assertions hold without a native renderer.
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: ({
    frames,
    mirrored,
    filledStyle,
    style,
  }: {
    frames: string;
    mirrored?: boolean;
    filledStyle?: boolean;
    style?: unknown;
  }) => {
    const readStyleValue = (styleKey: string): unknown => {
      const styles = Array.isArray(style) ? style : [style];
      for (const styleEntry of styles) {
        if (
          styleEntry != null &&
          typeof styleEntry === 'object' &&
          Object.prototype.hasOwnProperty.call(styleEntry, styleKey)
        ) {
          return (styleEntry as Record<string, unknown>)[styleKey];
        }
      }
      return null;
    };
    const width = readStyleValue('width');
    const height = readStyleValue('height');
    const borderRadius = readStyleValue('borderRadius');
    const overflow = readStyleValue('overflow');

    return createElement('div', {
      'data-thumbnail': frames,
      'data-mirrored': mirrored ? 'true' : 'false',
      'data-filled': filledStyle ? 'true' : 'false',
      'data-board-width': styleDataValue(width),
      'data-board-height': styleDataValue(height),
      'data-board-border-radius': styleDataValue(borderRadius),
      'data-board-overflow': styleDataValue(overflow),
    });
  },
}));

vi.mock('../../play-drawer/use-carousel-gesture', () => ({
  useCarouselGesture: () => ({ gesture: {}, translateX: { value: 0 } }),
}));

vi.mock('../LogAscentToolbarButton', () => ({
  LogAscentToolbarButton: ({ size, iconSize }: { size?: number; iconSize?: number }) =>
    createElement('button', {
      'data-tick': 'true',
      'data-tick-size': String(size),
      'data-icon-size': String(iconSize),
    }),
}));

import { NativeAccessoryClimbRow } from '../NativeAccessoryClimbRow';

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    setter_username: 'setter',
    name: "Alvin's Nuts",
    frames: 'p1r12',
    angle: 40,
    ascensionist_count: 8,
    difficulty: 'V6',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    ...overrides,
  };
}

function makeItem(climb: Climb): ClimbQueueItem {
  return { uuid: climb.uuid, climb };
}

function makeBoardConfig(): BoardConfig {
  return { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
}

function getCurrentThumbnail(container: HTMLElement): HTMLElement {
  const thumbnail = container.querySelector('[data-thumbnail="p1r12"]');
  expect(thumbnail).not.toBeNull();
  return thumbnail as HTMLElement;
}

function expectNumericAttribute(element: HTMLElement, attributeName: string, expectedValue: number) {
  expect(Number(element.getAttribute(attributeName))).toBeCloseTo(expectedValue, 3);
}

describe('NativeAccessoryClimbRow', () => {
  beforeEach(() => {
    nav.result = { canNext: false, canPrevious: false, nextItem: null, prevItem: null, remainingCount: 0 };
    const currentItem = makeItem(makeClimb());
    queue.state.currentClimbQueueItem = currentItem;
    queue.state.queue = [currentItem];
    drawer.boardConfig = makeBoardConfig();
    boardRender.boardWidth = 1080;
    boardRender.boardHeight = 1920;
    queue.sessionId = null;
    route.segments = ['(tabs)', 'climbs'];
    router.navigate.mockClear();
    queue.nextClimb.mockClear();
    queue.previousClimb.mockClear();
    drawer.openPlayDrawer.mockClear();
  });

  it('renders a regular now-climbing row with thumbnail, grade, and integrated tick', () => {
    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);

    expect(container.textContent).toContain("Alvin's Nuts");
    expect(container.textContent).toContain('V6');
    expect(container.querySelector('[data-thumbnail="p1r12"]')).not.toBeNull();
    expect(container.querySelector('[data-thumbnail="p1r12"]')?.getAttribute('data-mirrored')).toBe('false');
    // Filled hold style so the lit holds read as solid dots at the 40×40 slot,
    // matching the list thumbnail (and sharing its render cache key).
    expect(container.querySelector('[data-thumbnail="p1r12"]')?.getAttribute('data-filled')).toBe('true');
    expect(container.querySelector('[data-tick-size="44"]')).not.toBeNull();
    expect(container.querySelector('[data-icon-size="24"]')).not.toBeNull();
    expect(container.querySelector('[data-height="48"]')).not.toBeNull();
    expect(container.querySelector('[data-padding-right="12"]')).not.toBeNull();

    const thumbnail = getCurrentThumbnail(container);
    const thumbnailSlot = thumbnail.closest('[data-width="40"][data-height="40"]');
    expect(thumbnailSlot).not.toBeNull();
    expect(thumbnailSlot?.getAttribute('data-background-color')).toBe('');
    expect(thumbnailSlot?.getAttribute('data-border-width')).toBe('');
    expect(thumbnailSlot?.getAttribute('data-border-color')).toBe('');
    expect(thumbnailSlot?.getAttribute('data-border-radius')).toBe('');
    expect(thumbnailSlot?.getAttribute('data-overflow')).toBe('');
    expectNumericAttribute(thumbnail, 'data-board-width', 22.5);
    expectNumericAttribute(thumbnail, 'data-board-height', 40);
    expect(thumbnail.getAttribute('data-board-border-radius')).toBe('10');
    expect(thumbnail.getAttribute('data-board-overflow')).toBe('hidden');

    const climbNameText = Array.from(container.querySelectorAll('[data-text]')).find(
      (textNode) => textNode.textContent === "Alvin's Nuts",
    );
    expect(climbNameText?.getAttribute('data-variant')).toBe('subheadline');
    expect(climbNameText?.getAttribute('data-font-weight')).toBe('500');

    const gradeText = Array.from(container.querySelectorAll('[data-text]')).find(
      (textNode) => textNode.textContent === 'V6',
    );
    expect(gradeText?.getAttribute('data-color')).toBe('#111111');
    expect(gradeText?.getAttribute('data-variant')).toBe('subheadline');
    expect(gradeText?.getAttribute('data-font-weight')).toBe('600');
  });

  it('flips the thumbnail for a mirrored climb', () => {
    const mirroredItem = makeItem(makeClimb({ mirrored: true }));
    queue.state.currentClimbQueueItem = mirroredItem;
    queue.state.queue = [mirroredItem];

    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);

    const thumbnail = getCurrentThumbnail(container);
    expect(thumbnail.getAttribute('data-mirrored')).toBe('true');
    // The filled style is independent of mirroring — still on.
    expect(thumbnail.getAttribute('data-filled')).toBe('true');
  });

  it('uses the full silhouette for very tall board thumbnails', () => {
    boardRender.boardWidth = 1080;
    boardRender.boardHeight = 2498;
    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);
    const thumbnail = getCurrentThumbnail(container);

    expectNumericAttribute(thumbnail, 'data-board-width', 17.293835);
    expectNumericAttribute(thumbnail, 'data-board-height', 40);
  });

  it('keeps near-square Kilter Homewall thumbnails off the accessory edges', () => {
    boardRender.boardWidth = 1080;
    boardRender.boardHeight = 1157;
    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);
    const thumbnail = getCurrentThumbnail(container);

    expect(container.querySelector('[data-height="48"]')).not.toBeNull();
    expect(thumbnail.closest('[data-width="40"][data-height="40"]')).not.toBeNull();
    expectNumericAttribute(thumbnail, 'data-board-width', 37.337943);
    expectNumericAttribute(thumbnail, 'data-board-height', 40);
  });

  it('uses the full silhouette for wide board thumbnails', () => {
    boardRender.boardWidth = 1200;
    boardRender.boardHeight = 663;
    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);
    const thumbnail = getCurrentThumbnail(container);

    expectNumericAttribute(thumbnail, 'data-board-width', 40);
    expectNumericAttribute(thumbnail, 'data-board-height', 22.1);
  });

  it('keeps the thumbnail out of inline placement', () => {
    const { container } = render(<NativeAccessoryClimbRow placement="inline" width={344} />);

    expect(container.textContent).toContain("Alvin's Nuts");
    expect(container.querySelector('[data-thumbnail]')).toBeNull();
    expect(container.querySelector('[data-tick-size="44"]')).not.toBeNull();
    expect(container.querySelector('[data-height="44"]')).not.toBeNull();
  });

  it('omits the thumbnail when board config is unavailable', () => {
    drawer.boardConfig = null;
    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);

    expect(container.textContent).toContain("Alvin's Nuts");
    expect(container.querySelector('[data-thumbnail]')).toBeNull();
    expect(container.querySelector('[data-tick-size="44"]')).not.toBeNull();
  });

  it('keeps the tick outside the climb gesture target', () => {
    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);
    const tick = container.querySelector('[data-tick="true"]');

    expect(tick).not.toBeNull();
    expect(tick?.closest('[data-gesture="true"]')).toBeNull();
  });

  it('shows a session-return cue when a live session can be resumed from another tab', () => {
    queue.sessionId = 'session-1';

    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);

    expect(container.querySelector('[data-testid="session-return-cue"]')).not.toBeNull();
  });

  it('hides the session-return cue on the Record tab', () => {
    queue.sessionId = 'session-1';
    route.segments = ['(tabs)', 'record'];

    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);

    expect(container.querySelector('[data-testid="session-return-cue"]')).toBeNull();
  });

  it('surfaces the suggestion-aware next item as a peek and a "next" accessibility action', () => {
    const currentItem = makeItem(makeClimb({ uuid: 'current', name: 'Current Climb' }));
    queue.state.currentClimbQueueItem = currentItem;
    queue.state.queue = [currentItem];
    // Navigation reports a next item even though only one climb is queued — i.e.
    // a playlist suggestion peek past the tail. The carousel must reflect it
    // rather than dead-ending, and expose a VoiceOver "next" action.
    nav.result = {
      canNext: true,
      canPrevious: false,
      nextItem: makeItem(makeClimb({ uuid: 'peek', name: 'Playlist Next', difficulty: 'V9' })),
      prevItem: null,
      remainingCount: 0,
    };

    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);

    expect(container.textContent).toContain('Current Climb');
    expect(container.textContent).toContain('Playlist Next');
    const swipeTarget = container.querySelector('[data-role="button"]');
    expect(swipeTarget?.getAttribute('data-actions')).toContain('next');
  });

  it('exposes no "next" action and no peek at the navigation tail', () => {
    // Default nav.result (set in beforeEach) reports no next/previous item.
    const { container } = render(<NativeAccessoryClimbRow placement="regular" width={344} />);

    const swipeTarget = container.querySelector('[data-role="button"]');
    expect(swipeTarget?.getAttribute('data-actions')).toBe('');
  });
});
