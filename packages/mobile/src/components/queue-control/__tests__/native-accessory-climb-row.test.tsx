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
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
}));

const drawer = vi.hoisted(() => ({
  boardConfig: null as BoardConfig | null,
  openPlayDrawer: vi.fn(),
}));

const boardRender = vi.hoisted(() => ({
  boardWidth: 1080,
  boardHeight: 1920,
}));

function styleDataValue(styleValue: unknown): string {
  if (styleValue == null) return '';
  if (typeof styleValue === 'string' || typeof styleValue === 'number' || typeof styleValue === 'boolean') {
    return String(styleValue);
  }
  return JSON.stringify(styleValue);
}

// useAccessoryClimbTap builds a preview queue item via climbToQueueItem, which
// pulls expo-crypto's randomUUID — stub it so the native module isn't loaded.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));

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
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
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
      },
      children,
    );
  },
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) =>
    createElement(
      'button',
      { 'data-hide-control': 'true', 'data-label': accessibilityLabel ?? '', onClick: onPress },
      children,
    ),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
  },
}));

// The tap hook wraps its open handler in runOnJS — return it as-is.
vi.mock('react-native-reanimated', () => ({
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
}));

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

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon-name': name }),
}));
vi.mock('../../../hooks/use-actively-climbing', () => ({ useIsActivelyClimbing: () => false }));
vi.mock('../../../lib/accessory-dismiss-store', () => ({ dismissAccessory: vi.fn() }));

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
  }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({
    state: queue.state,
    nextClimb: queue.nextClimb,
    previousClimb: queue.previousClimb,
  }),
  useActiveClimbQueueItemUuid: () => queue.state.currentClimbQueueItem?.uuid ?? null,
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardConfig: drawer.boardConfig, openPlayDrawer: drawer.openPlayDrawer }),
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (difficulty: string | null | undefined) => difficulty }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));

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

vi.mock('../LogAscentToolbarButton', () => ({
  LogAscentToolbarButton: ({ size, iconSize }: { size?: number; iconSize?: number }) =>
    createElement('button', {
      'data-tick': 'true',
      'data-tick-size': String(size),
      'data-icon-size': String(iconSize),
    }),
}));

// Board-presence source flip: identity passthrough (flag off / no wall feed) so
// the row renders the local queue head exactly as today.
vi.mock('../use-wall-or-queue-climb', () => ({
  useWallOrQueueCurrentClimb: (localClimb: unknown) => localClimb,
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

// The displayed climb is now passed in by QueueBottomAccessory; default to the
// queue head the test set up so the existing assertions keep reading it.
function renderRow(placement: 'regular' | 'inline', width = 344) {
  const climb = queue.state.currentClimbQueueItem?.climb as Climb;
  return render(<NativeAccessoryClimbRow climb={climb} placement={placement} width={width} />);
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
    const currentItem = makeItem(makeClimb());
    queue.state.currentClimbQueueItem = currentItem;
    queue.state.queue = [currentItem];
    drawer.boardConfig = makeBoardConfig();
    boardRender.boardWidth = 1080;
    boardRender.boardHeight = 1920;
    queue.nextClimb.mockClear();
    queue.previousClimb.mockClear();
    drawer.openPlayDrawer.mockClear();
  });

  it('renders a regular now-climbing row with thumbnail, grade, and integrated tick', () => {
    const { container } = renderRow('regular');

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

    const { container } = renderRow('regular');

    const thumbnail = getCurrentThumbnail(container);
    expect(thumbnail.getAttribute('data-mirrored')).toBe('true');
    // The filled style is independent of mirroring — still on.
    expect(thumbnail.getAttribute('data-filled')).toBe('true');
  });

  it('uses the full silhouette for very tall board thumbnails', () => {
    boardRender.boardWidth = 1080;
    boardRender.boardHeight = 2498;
    const { container } = renderRow('regular');
    const thumbnail = getCurrentThumbnail(container);

    expectNumericAttribute(thumbnail, 'data-board-width', 17.293835);
    expectNumericAttribute(thumbnail, 'data-board-height', 40);
  });

  it('keeps near-square Kilter Homewall thumbnails off the accessory edges', () => {
    boardRender.boardWidth = 1080;
    boardRender.boardHeight = 1157;
    const { container } = renderRow('regular');
    const thumbnail = getCurrentThumbnail(container);

    expect(container.querySelector('[data-height="48"]')).not.toBeNull();
    expect(thumbnail.closest('[data-width="40"][data-height="40"]')).not.toBeNull();
    expectNumericAttribute(thumbnail, 'data-board-width', 37.337943);
    expectNumericAttribute(thumbnail, 'data-board-height', 40);
  });

  it('uses the full silhouette for wide board thumbnails', () => {
    boardRender.boardWidth = 1200;
    boardRender.boardHeight = 663;
    const { container } = renderRow('regular');
    const thumbnail = getCurrentThumbnail(container);

    expectNumericAttribute(thumbnail, 'data-board-width', 40);
    expectNumericAttribute(thumbnail, 'data-board-height', 22.1);
  });

  it('keeps the thumbnail out of inline placement', () => {
    const { container } = renderRow('inline');

    expect(container.textContent).toContain("Alvin's Nuts");
    expect(container.querySelector('[data-thumbnail]')).toBeNull();
    expect(container.querySelector('[data-tick-size="44"]')).not.toBeNull();
    expect(container.querySelector('[data-height="44"]')).not.toBeNull();
  });

  it('omits the thumbnail when board config is unavailable', () => {
    drawer.boardConfig = null;
    const { container } = renderRow('regular');

    expect(container.textContent).toContain("Alvin's Nuts");
    expect(container.querySelector('[data-thumbnail]')).toBeNull();
    expect(container.querySelector('[data-tick-size="44"]')).not.toBeNull();
  });

  it('keeps the tick outside the climb gesture target', () => {
    const { container } = renderRow('regular');
    const tick = container.querySelector('[data-tick="true"]');

    expect(tick).not.toBeNull();
    expect(tick?.closest('[data-gesture="true"]')).toBeNull();
  });

  it('renders a single climb label with no swipe peek or prev/next actions', () => {
    // The swipe carousel + peeking neighbours were removed: the row shows only the
    // current climb, the gesture target is tap-to-open (no prev/next a11y actions),
    // and exactly one name node renders.
    const currentItem = makeItem(makeClimb({ uuid: 'current', name: 'Current Climb' }));
    queue.state.currentClimbQueueItem = currentItem;
    queue.state.queue = [currentItem];

    const { container } = renderRow('regular');

    const nameNodes = Array.from(container.querySelectorAll('[data-text]')).filter(
      (textNode) => textNode.textContent === 'Current Climb',
    );
    expect(nameNodes).toHaveLength(1);

    const tapTarget = container.querySelector('[data-role="button"]');
    expect(tapTarget?.getAttribute('data-actions')).toBe('');
  });

  it('renders the passed climb even when the local queue head is empty', () => {
    // QueueBottomAccessory owns the single render gate; the row must not re-gate on
    // its own queue read (an empty-vs-content flip inside the live platter is what
    // UIKit snapshotted as doubled text). With no queue head, the prop still draws.
    queue.state.currentClimbQueueItem = null;
    queue.state.queue = [];

    const { container } = render(
      <NativeAccessoryClimbRow
        climb={makeClimb({ uuid: 'wall', name: 'On The Wall' })}
        placement="regular"
        width={344}
      />,
    );

    expect(container.textContent).toContain('On The Wall');
    expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
  });
});
