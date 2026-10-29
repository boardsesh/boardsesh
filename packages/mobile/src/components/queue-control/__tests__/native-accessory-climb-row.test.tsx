// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
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

// The live sends/rating the byline reads (the list rows' stats store). Null keeps
// the climb's own counts, as the store does before a canonical row lands.
const liveStats = vi.hoisted(() => ({
  override: null as { ascensionistCount: number; qualityAverage: string | null } | null,
}));
vi.mock('@boardsesh/board-react', () => ({
  useEffectiveClimbStats: (
    _boardType: string,
    _layoutId: number,
    _climbUuid: string,
    _angle: number,
    base: { ascensionistCount?: number | null; qualityAverage?: string | null },
  ) =>
    liveStats.override ?? {
      ascensionistCount: base.ascensionistCount ?? 0,
      qualityAverage: base.qualityAverage ?? null,
      difficulty: null,
    },
}));

// Who holds the board. Default: a bound board nobody holds.
const connection = vi.hoisted(() => ({
  state: {
    bluetooth: {} as object | null,
    inAppBoardConnection: 'disconnected' as 'connectedByMe' | 'heldByPeer' | 'disconnected',
    ledless: false,
    holderDisplayName: null as string | null,
  },
}));
vi.mock('../../ble/use-board-connection-state', () => ({ useBoardConnectionState: () => connection.state }));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-icon-color': color ?? '' }),
}));

const drawer = vi.hoisted(() => ({
  boardConfig: null as BoardConfig | null,
  openPlayDrawer: vi.fn(),
}));

// The width every mocked View reports from its layout pass: the row reads it
// to decide whether the open platter fits both controls.
const layout = vi.hoisted(() => ({
  width: 400,
  callbacks: new WeakMap<Element, (event: { nativeEvent: { layout: { width: number; height: number } } }) => void>(),
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

vi.mock('../AccessoryPlayLink', () => ({
  AccessoryPlayLink: ({
    children,
    accessibilityLabel,
    accessibilityValue,
  }: {
    children: ReactNode;
    style?: unknown;
    accessibilityLabel: string;
    accessibilityValue?: string;
  }) =>
    createElement(
      'div',
      {
        'aria-label': accessibilityLabel,
        'data-a11y-value': accessibilityValue ?? '',
        'data-role': 'button',
        'data-actions': '',
        'data-accessory-play-link': true,
      },
      children,
    ),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: miniPlayer.windowWidth, height: 874, scale: 3, fontScale: 1 }),
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({
    children,
    style,
    accessibilityRole,
    accessibilityLabel,
    accessibilityActions,
    accessible,
    testID,
    onLayout,
    collapsable,
    pointerEvents,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
    accessible?: boolean;
    testID?: string;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
    collapsable?: boolean;
    pointerEvents?: string;
  }) => {
    // jsdom never lays out, so simulate the swipe viewport being measured —
    // otherwise width stays 0, canPeek is false, and the peek slots never render.
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: layout.width, height: 48 } } });
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
    const paddingEnd = readStyleValue('paddingEnd');
    const backgroundColor = readStyleValue('backgroundColor');
    const borderWidth = readStyleValue('borderWidth');
    const borderColor = readStyleValue('borderColor');
    const borderRadius = readStyleValue('borderRadius');
    const overflow = readStyleValue('overflow');
    const opacity = readStyleValue('opacity');
    return createElement(
      'div',
      {
        'data-width': styleDataValue(width),
        'data-right': styleDataValue(readStyleValue('right')),
        'data-position': styleDataValue(readStyleValue('position')),
        'data-flex-direction': styleDataValue(readStyleValue('flexDirection')),
        'data-collapsable': styleDataValue(collapsable),
        'data-pointer-events': pointerEvents,
        'data-opacity': styleDataValue(opacity),
        'data-height': styleDataValue(height),
        'data-padding-end': styleDataValue(paddingEnd),
        'data-background-color': styleDataValue(backgroundColor),
        'data-border-width': styleDataValue(borderWidth),
        'data-border-color': styleDataValue(borderColor),
        'data-border-radius': styleDataValue(borderRadius),
        'data-overflow': styleDataValue(overflow),
        'data-role': accessibilityRole ?? '',
        'data-label': accessibilityLabel ?? '',
        'aria-label': accessibilityLabel,
        'data-accessible': accessible,
        'data-testid': testID,
        'data-actions': Array.isArray(accessibilityActions)
          ? accessibilityActions.map((action) => action.name).join(',')
          : '',
        // Keep the real callback attached to this mounted host for resize tests.
        ref: (host: HTMLDivElement | null) => {
          if (host && onLayout) layout.callbacks.set(host, onLayout);
        },
      },
      children,
    );
  },
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
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
    Gesture: { Tap: () => builder },
  };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// The board control drags in the BLE stack + Icon (@expo/vector-icons); stub it
// with a marker so the layout tests see where it sits (it has its own unit test).
vi.mock('../BoardControlIndicator', () => ({
  BoardControlIndicator: ({ solidGlyphs, placement }: { solidGlyphs?: boolean; placement?: string }) =>
    connection.state.bluetooth
      ? createElement('span', {
          'data-board-control': 'true',
          'data-solid-glyphs': String(solidGlyphs === true),
          'data-placement': placement ?? '',
        })
      : null,
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

// MarqueeText (the scrolling climb-name label) has its own unit test; here it's
// a coloured text node. Font weight rides `textStyle`, so read it from there.
vi.mock('../../MarqueeText', () => ({
  MarqueeText: (props: TextMockProps & { textStyle?: TextMockProps['style'] }) =>
    createElement(
      'span',
      {
        'data-text': 'true',
        'data-color': readColor(props),
        'data-font-weight': readTextStyleValue({ style: props.textStyle }, 'fontWeight'),
        'data-variant': props.variant ?? '',
      },
      props.children,
    ),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { label: '#111111', secondaryLabel: '#777777' },
    brandColors: { warning: '#FBBF24', primary: '#6D28D9' },
  }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({
    state: queue.state,
    nextClimb: queue.nextClimb,
    previousClimb: queue.previousClimb,
  }),
  useQueueData: () => ({ currentClimbQueueItem: queue.state.currentClimbQueueItem }),
  useQueueSessionId: () => ({ sessionId: null }),
}));

// The MiniPlayer's buttons (#6940): the climber's layout, the device class and
// the Duo split. The buttons themselves have their own tests; here each one is
// a marker, so the tests see which ones the row placed and in what order.
const miniPlayer = vi.hoisted(() => ({
  windowWidth: 402,
  verticalTabBar: false,
  layout: null as null | { order: readonly string[]; visible: Record<string, boolean> },
  isTablet: false,
  phoneSplit: false,
  paneTaken: false,
  signedIn: true,
  angleAdjustable: true,
  playerButtons: null as null | { order: readonly string[]; visible: Record<string, boolean> },
  panePreview: false,
  position: 'below' as 'below' | 'above',
  playerRouteUp: false,
}));
vi.mock('../../../lib/mini-player-buttons-preference', async () => {
  const { DEFAULT_MINI_PLAYER_BUTTONS } = await import('../../../lib/mini-player-buttons');
  return { useMiniPlayerButtons: () => miniPlayer.layout ?? DEFAULT_MINI_PLAYER_BUTTONS };
});
vi.mock('../../../hooks/use-device-layout', () => ({ useDeviceLayout: () => ({ isTablet: miniPlayer.isTablet }) }));
vi.mock('../../../hooks/use-phone-split', () => ({ usePhoneSplit: () => miniPlayer.phoneSplit }));
vi.mock('../../../hooks/use-vertical-tab-bar', () => ({ useVerticalTabBar: () => miniPlayer.verticalTabBar }));
vi.mock('../../navigation/phone-split-pane-slot', () => ({ usePhoneSplitPaneTaken: () => miniPlayer.paneTaken }));
// The bar's workout gate has its own test (use-mini-player-workout-outcome);
// here it is set directly, and Fell / Sent are a marker.
const workoutGate = vi.hoisted(() => ({
  inTimedBlock: false,
  shown: null as null | { target: { queueItemUuid: string }; wallLeftAtMs: number | null },
}));
vi.mock('../use-mini-player-workout-outcome', () => ({ useMiniPlayerWorkoutOutcome: () => workoutGate }));
vi.mock('../MiniPlayerWorkoutButtons', () => ({
  MiniPlayerWorkoutButtons: ({ buttonIds }: { buttonIds: readonly string[] }) =>
    createElement('span', { 'data-workout-buttons': buttonIds.join(',') }),
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: miniPlayer.signedIn }) }));
vi.mock('expo-router', () => ({ useSegments: () => (miniPlayer.playerRouteUp ? ['play'] : ['(tabs)']) }));
vi.mock('../../play-drawer/pane-preview-store', () => ({ usePanePlayerShowsPreview: () => miniPlayer.panePreview }));
vi.mock('../../../lib/player-buttons-preference', async () => {
  const { DEFAULT_PLAYER_BUTTONS } = await import('../../../lib/player-buttons');
  return {
    usePlayerButtonsPreference: () => ({
      buttons: miniPlayer.playerButtons ?? DEFAULT_PLAYER_BUTTONS,
      previousNext: true,
      position: miniPlayer.position,
    }),
  };
});
// The climb is drawn on the active board, as every climb in these tests is.
vi.mock('../../../lib/boards/climb-render-board', () => ({
  resolveClimbRenderBoard: (_climb: unknown, boardConfig: unknown) => (boardConfig ? { boardConfig } : null),
}));
vi.mock('../MiniPlayerButtons', () => ({
  MiniPlayerLeadingButtons: ({ buttonIds }: { buttonIds: readonly string[] }) =>
    createElement('span', { 'data-mini-player-buttons': buttonIds.join(',') }),
  MiniPlayerWallDisplayButton: () => createElement('span', { 'data-wall-display': 'true' }),
}));

// ⋯ has its own test (mini-player-actions-menu); here it is a marker.
vi.mock('../MiniPlayerActionsMenu', () => ({
  MiniPlayerActionsMenu: ({ shownButtons }: { shownButtons: readonly string[] }) =>
    createElement('span', { 'data-more-menu': shownButtons.join(',') }),
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({
    boardConfig: drawer.boardConfig,
    openPlayDrawer: drawer.openPlayDrawer,
    // The player's board: the stored one, as no foreign climb is open here.
    playDrawerPaneProps: drawer.boardConfig
      ? { boardConfig: drawer.boardConfig, isAngleAdjustable: miniPlayer.angleAdjustable }
      : null,
  }),
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (difficulty: string | null | undefined) => difficulty }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));

vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 8: 32, 10: 40 },
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
  LogAscentToolbarButton: ({
    size,
    iconSize,
    placement,
    appearance,
  }: {
    size?: number;
    iconSize?: number;
    placement?: string;
    appearance?: string;
  }) =>
    createElement('button', {
      'data-tick': 'true',
      'data-appearance': appearance ?? 'plain',
      'data-placement': placement ?? '',
      'data-tick-size': String(size),
      'data-icon-size': String(iconSize),
    }),
}));

import { NativeAccessoryClimbRow } from '../NativeAccessoryClimbRow';
import { getMeasuredMiniPlayerBar, resetMeasuredMiniPlayerBar } from '../../../lib/mini-player-measured-bar-store';
import { useBarCarriesPaneWorkoutRow } from '../../play-drawer/pane-workout-row-cover-store';

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
function renderRow(placement: 'regular' | 'inline') {
  const climb = queue.state.currentClimbQueueItem?.climb as Climb;
  return render(<NativeAccessoryClimbRow climb={climb} placement={placement} />);
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
  // Each placement fills the frame UIKit gives it. A width worked out from the
  // screen overshot the real platter and crammed the tick into its edge.
  it.each(['regular', 'inline'] as const)('fills the %s platter frame instead of pinning a width', (placement) => {
    const { container } = renderRow(placement);
    expect((container.firstElementChild as HTMLElement).getAttribute('data-width')).toBe('');
  });

  it.each(['regular', 'inline'] as const)('exposes the existing %s row as the CPP accessibility host', (placement) => {
    const { container } = render(
      <NativeAccessoryClimbRow climb={makeClimb()} placement={placement} testID="cpp-accessory-climb-climb-1" />,
    );
    const host = container.querySelector('[data-testid="cpp-accessory-climb-climb-1"]');
    expect(host).toBe(container.firstElementChild);
    expect(host?.getAttribute('aria-label')).toBe("Alvin's Nuts");
    expect(host?.getAttribute('data-accessible')).toBe('true');
    expect(host?.querySelector('[data-accessory-play-link]')).not.toBeNull();
    expect(host?.querySelector('[data-accessory-play-link]')?.getAttribute('data-testid')).toBeNull();
  });
  beforeEach(() => {
    const currentItem = makeItem(makeClimb());
    queue.state.currentClimbQueueItem = currentItem;
    queue.state.queue = [currentItem];
    drawer.boardConfig = makeBoardConfig();
    layout.width = 400;
    resetMeasuredMiniPlayerBar();
    boardRender.boardWidth = 1080;
    boardRender.boardHeight = 1920;
    queue.nextClimb.mockClear();
    queue.previousClimb.mockClear();
    liveStats.override = null;
    drawer.openPlayDrawer.mockClear();
    connection.state = { bluetooth: {}, inAppBoardConnection: 'disconnected', ledless: false, holderDisplayName: null };
    miniPlayer.layout = null;
    miniPlayer.isTablet = false;
    miniPlayer.windowWidth = 402;
    miniPlayer.verticalTabBar = false;
    miniPlayer.phoneSplit = false;
    miniPlayer.paneTaken = false;
    miniPlayer.signedIn = true;
    miniPlayer.angleAdjustable = true;
    miniPlayer.playerButtons = null;
    miniPlayer.panePreview = false;
    miniPlayer.position = 'below';
    miniPlayer.playerRouteUp = false;
    workoutGate.inTimedBlock = false;
    workoutGate.shown = null;
  });

  it('renders a regular now-climbing row with thumbnail, grade, and integrated tick', () => {
    const { container } = renderRow('regular');

    expect(container.firstElementChild?.getAttribute('data-accessible')).toBeNull();
    expect(container.firstElementChild?.getAttribute('aria-label')).toBeNull();
    expect(container.firstElementChild?.getAttribute('data-testid')).toBeNull();
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
    // Apple Music's insets: the last control's centre ~30pt from the right edge.
    expect(container.querySelector('[data-padding-end="8"]')).not.toBeNull();

    const thumbnail = getCurrentThumbnail(container);
    const thumbnailSlot = thumbnail.closest('[data-width="40"][data-height="40"]');
    expect(thumbnailSlot).not.toBeNull();
    expect(thumbnailSlot?.getAttribute('data-background-color')).toBe('');
    expect(thumbnailSlot?.getAttribute('data-border-width')).toBe('');
    expect(thumbnailSlot?.getAttribute('data-border-color')).toBe('');
    expect(thumbnailSlot?.getAttribute('data-border-radius')).toBe('');
    expect(thumbnailSlot?.getAttribute('data-overflow')).toBe('');
    expectNumericAttribute(thumbnail, 'data-board-width', 18);
    expectNumericAttribute(thumbnail, 'data-board-height', 32);
    expect(thumbnail.getAttribute('data-board-border-radius')).toBe('8');
    expect(thumbnail.getAttribute('data-board-overflow')).toBe('hidden');

    const climbNameText = Array.from(container.querySelectorAll('[data-text]')).find(
      (textNode) => textNode.textContent === "Alvin's Nuts",
    );
    expect(climbNameText?.getAttribute('data-variant')).toBe('subheadline');
    expect(climbNameText?.getAttribute('data-font-weight')).toBe('500');

    // The grade rides a byline under the name, like an artist under a song.
    const byline = Array.from(container.querySelectorAll('[data-text]')).find((textNode) =>
      textNode.textContent?.startsWith('V6'),
    );
    expect(byline?.textContent).toBe('V6 · sends');
    expect(byline?.getAttribute('data-color')).toBe('#777777');
    expect(byline?.getAttribute('data-variant')).toBe('footnote');
  });

  it('reads the byline from the live stats, and falls back to the rating, then the grade alone', () => {
    liveStats.override = { ascensionistCount: 0, qualityAverage: '3.24' };
    const rated = renderRow('regular');
    expect(rated.container.textContent).toContain('V6 · 3.2★');
    rated.unmount();

    liveStats.override = { ascensionistCount: 0, qualityAverage: null };
    const bare = renderRow('regular');
    const byline = Array.from(bare.container.querySelectorAll('[data-text]')).find((textNode) =>
      textNode.textContent?.startsWith('V6'),
    );
    expect(byline?.textContent).toBe('V6');
  });

  it('puts the lightbulb beside the tick on the open platter, outside the climb tap', () => {
    const { container } = renderRow('regular');
    const bulb = container.querySelector('[data-board-control="true"]');
    const tick = container.querySelector('[data-tick="true"]');

    expect(bulb).not.toBeNull();
    // Solid like Music's platter controls (the indicator brings the outline back
    // under Differentiate Without Color).
    expect(bulb?.getAttribute('data-solid-glyphs')).toBe('true');
    expect(bulb?.closest('[data-gesture="true"]')).toBeNull();
    // Bulb first, then the tick at the trailing edge.
    expect(bulb!.compareDocumentPosition(tick!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

    expectNumericAttribute(thumbnail, 'data-board-width', 13.835068);
    expectNumericAttribute(thumbnail, 'data-board-height', 32);
  });

  it('keeps near-square Kilter Homewall thumbnails off the accessory edges', () => {
    boardRender.boardWidth = 1080;
    boardRender.boardHeight = 1157;
    const { container } = renderRow('regular');
    const thumbnail = getCurrentThumbnail(container);

    expect(container.querySelector('[data-height="48"]')).not.toBeNull();
    expect(thumbnail.closest('[data-width="40"][data-height="40"]')).not.toBeNull();
    expectNumericAttribute(thumbnail, 'data-board-width', 29.870354);
    expectNumericAttribute(thumbnail, 'data-board-height', 32);
  });

  it('uses the full silhouette for wide board thumbnails', () => {
    boardRender.boardWidth = 1200;
    boardRender.boardHeight = 663;
    const { container } = renderRow('regular');
    const thumbnail = getCurrentThumbnail(container);

    expectNumericAttribute(thumbnail, 'data-board-width', 32);
    expectNumericAttribute(thumbnail, 'data-board-height', 17.68);
  });

  it('shows the thumbnail, the byline and the tick, but no lightbulb, when collapsed and connected', () => {
    connection.state.inAppBoardConnection = 'connectedByMe';
    const { container } = renderRow('inline');

    expect(container.textContent).toContain("Alvin's Nuts");
    expect(container.textContent).toContain('V6 · sends');
    // The same 32pt box as the open platter (this board is portrait, so 32pt tall).
    expectNumericAttribute(getCurrentThumbnail(container), 'data-board-height', 32);
    expect(container.querySelector('[data-board-control]')).toBeNull();
    expect(container.querySelector('[data-tick-size="44"]')).not.toBeNull();
    expect(container.querySelector('[data-height="44"]')).not.toBeNull();
  });

  describe("the collapsed platter's one slot", () => {
    function resizeRow(container: HTMLElement, width: number) {
      const onLayout = layout.callbacks.get(container.firstElementChild as Element);
      expect(onLayout).toBeDefined();
      act(() => onLayout?.({ nativeEvent: { layout: { width, height: 48 } } }));
    }

    it.each(['connectedByMe', 'heldByPeer', 'unbound'] as const)(
      'retains the tick and its native slot through repeated resizing when %s',
      (boardState) => {
        miniPlayer.verticalTabBar = true;
        layout.width = 290;
        if (boardState === 'unbound') connection.state.bluetooth = null;
        else connection.state.inAppBoardConnection = boardState;
        const { container } = renderRow('regular');
        const tick = container.querySelector('[data-tick="true"]');
        const tickSlot = tick?.parentElement;
        const pair = tickSlot?.parentElement;
        const bulbSlot = pair?.firstElementChild;
        const row = container.firstElementChild;
        expect(tick).not.toBeNull();
        expect(tickSlot?.getAttribute('data-width')).toBe('44');
        expect(tickSlot?.getAttribute('data-collapsable')).toBe('false');
        expect(pair?.getAttribute('data-width')).toBe('88');
        expect(pair?.getAttribute('data-position')).toBe('absolute');
        expect(pair?.getAttribute('data-flex-direction')).toBe('row');
        expect(pair?.getAttribute('data-collapsable')).toBe('false');
        expect(pair?.getAttribute('data-pointer-events')).toBe('box-none');
        expect(pair?.parentElement?.getAttribute('data-pointer-events')).toBe('box-none');
        expect(tickSlot?.getAttribute('data-pointer-events')).toBe('box-none');
        expect(pair?.children.length).toBe(2);
        expect(bulbSlot?.getAttribute('data-width')).toBe('44');
        expect(bulbSlot?.getAttribute('data-collapsable')).toBe('false');
        expect(bulbSlot?.getAttribute('data-pointer-events')).toBe('box-none');
        expect(container.querySelector('[data-board-control]')).toBeNull();

        for (const width of [370, 290, 370]) {
          resizeRow(container, width);
          expect(container.firstElementChild).toBe(row);
          expect(container.querySelector('[data-tick="true"]')).toBe(tick);
          expect(tick?.parentElement).toBe(tickSlot);
          expect(tickSlot?.parentElement).toBe(pair);
          expect(pair?.firstElementChild).toBe(bulbSlot);
          expect(pair?.getAttribute('data-width')).toBe('88');
          expect(pair?.getAttribute('data-right')).toBe('0');
          expect(pair?.parentElement?.getAttribute('data-width')).toBe(width === 370 ? '88' : '44');
          expect(tickSlot?.getAttribute('data-width')).toBe('44');
          expect(container.querySelector('[data-board-control]') !== null).toBe(
            width === 370 && boardState !== 'unbound',
          );
        }
      },
    );

    it('retains the disconnected bulb and its native slot through repeated resizing', () => {
      miniPlayer.verticalTabBar = true;
      layout.width = 290;
      const { container } = renderRow('regular');
      const bulb = container.querySelector('[data-board-control]');
      const bulbSlot = bulb?.parentElement;
      const pair = bulbSlot?.parentElement;
      const tickSlot = pair?.lastElementChild;
      const row = container.firstElementChild;
      expect(bulb).not.toBeNull();
      expect(bulbSlot?.getAttribute('data-width')).toBe('44');
      expect(pair?.getAttribute('data-width')).toBe('88');
      expect(pair?.getAttribute('data-flex-direction')).toBe('row');
      expect(pair?.getAttribute('data-collapsable')).toBe('false');
      expect(pair?.getAttribute('data-right')).toBe('-44');
      expect(tickSlot?.getAttribute('data-width')).toBe('44');
      expect(tickSlot?.getAttribute('data-collapsable')).toBe('false');
      expect(container.querySelector('[data-tick="true"]')).toBeNull();

      for (const width of [370, 290, 370]) {
        resizeRow(container, width);
        expect(container.firstElementChild).toBe(row);
        expect(container.querySelector('[data-board-control]')).toBe(bulb);
        expect(bulb?.parentElement).toBe(bulbSlot);
        expect(bulbSlot?.parentElement).toBe(pair);
        expect(pair?.lastElementChild).toBe(tickSlot);
        expect(pair?.getAttribute('data-width')).toBe('88');
        expect(pair?.getAttribute('data-right')).toBe(width === 370 ? '0' : '-44');
        expect(pair?.parentElement?.getAttribute('data-width')).toBe(width === 370 ? '88' : '44');
        expect(bulbSlot?.getAttribute('data-width')).toBe('44');
        expect(container.querySelector('[data-tick="true"]') !== null).toBe(width === 370);
      }
    });

    it('changes the narrow control as the board connects and disconnects without remounting the row', () => {
      miniPlayer.verticalTabBar = true;
      layout.width = 290;
      const climb = queue.state.currentClimbQueueItem?.climb as Climb;
      const { container, rerender } = render(<NativeAccessoryClimbRow climb={climb} placement="regular" />);
      const row = container.firstElementChild;
      expect(container.querySelector('[data-board-control]')).not.toBeNull();
      expect(container.querySelector('[data-tick="true"]')).toBeNull();

      connection.state.inAppBoardConnection = 'connectedByMe';
      rerender(<NativeAccessoryClimbRow climb={climb} placement="regular" />);
      expect(container.firstElementChild).toBe(row);
      expect(container.querySelector('[data-board-control]')).toBeNull();
      expect(container.querySelector('[data-tick="true"]')).not.toBeNull();

      connection.state.inAppBoardConnection = 'disconnected';
      rerender(<NativeAccessoryClimbRow climb={climb} placement="regular" />);
      expect(container.firstElementChild).toBe(row);
      expect(container.querySelector('[data-board-control]')).not.toBeNull();
      expect(container.querySelector('[data-tick="true"]')).toBeNull();
    });

    it('offers the lightbulb while the board is free, and no tick', () => {
      const { container } = renderRow('inline');
      const bulb = container.querySelector('[data-board-control="true"]');
      expect(bulb).not.toBeNull();
      expect(bulb?.getAttribute('data-placement')).toBe('inline');
      expect(bulb?.closest('[data-accessory-play-link]')).toBeNull();
      expect(container.querySelector('[data-tick="true"]')).toBeNull();
    });

    it.each(['connectedByMe', 'heldByPeer'] as const)('swaps to the tick once the board is %s', (state) => {
      connection.state.inAppBoardConnection = state;
      const { container } = renderRow('inline');
      expect(container.querySelector('[data-board-control]')).toBeNull();
      expect(container.querySelector('[data-tick="true"]')?.getAttribute('data-placement')).toBe('inline');
    });

    it('keeps the tick when no board is bound: there is nothing to connect to', () => {
      connection.state.bluetooth = null;
      const { container } = renderRow('inline');
      expect(container.querySelector('[data-board-control]')).toBeNull();
      expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
    });

    it.each(['connectedByMe', 'heldByPeer', 'disconnected'] as const)(
      'keeps both controls on the open platter when the board is %s',
      (state) => {
        connection.state.inAppBoardConnection = state;
        const { container } = renderRow('regular');
        expect(container.querySelector('[data-board-control]')?.getAttribute('data-placement')).toBe('regular');
        expect(container.querySelector('[data-tick="true"]')?.getAttribute('data-placement')).toBe('regular');
      },
    );

    it.each([
      // The platter beside iPhone Duo's side tab rail in the closed shots.
      ['290pt (iPhone Duo outer display)', 290, 466, true],
      // INFERRED: a 320pt-wide Display Zoom iPhone (SE, 13 mini) less the platter margins.
      ['278pt (320pt Display Zoom iPhone)', 278, 320, false],
    ] as const)('keeps one slot on a narrow open platter: %s', (_label, platterWidth, windowWidth, vertical) => {
      layout.width = platterWidth;
      miniPlayer.windowWidth = windowWidth;
      miniPlayer.verticalTabBar = vertical;
      const free = renderRow('regular');
      expect(free.container.querySelector('[data-board-control]')?.getAttribute('data-placement')).toBe('regular');
      expect(free.container.querySelector('[data-tick="true"]')).toBeNull();
      free.unmount();

      connection.state.inAppBoardConnection = 'connectedByMe';
      const held = renderRow('regular');
      expect(held.container.querySelector('[data-board-control]')).toBeNull();
      expect(held.container.querySelector('[data-tick="true"]')?.getAttribute('data-placement')).toBe('regular');
      // The bulb is gone, so the climb link says who holds the board.
      expect(held.container.querySelector('[data-accessory-play-link]')?.getAttribute('data-a11y-value')).toBe(
        'ble.barControl.connectedLabel',
      );
    });
  });

  describe('expanded phone readiness', () => {
    it.each(['connectedByMe', 'heldByPeer', 'disconnected'] as const)(
      'keeps expanded controls mounted while the shared host is inline, when %s',
      (boardState) => {
        connection.state.inAppBoardConnection = boardState;
        layout.width = 222;
        const { container } = renderRow('regular');
        const row = container.firstElementChild as Element;
        const bulb = container.querySelector('[data-board-control]');
        const tick = container.querySelector('[data-tick="true"]');
        expect(bulb).not.toBeNull();
        expect(tick).not.toBeNull();
        expect(container.querySelector('[data-mini-player-buttons]')?.getAttribute('data-mini-player-buttons')).toBe(
          'next',
        );
        expect(getMeasuredMiniPlayerBar()).toEqual({ rowWidth: 360, widthBesideName: 68 });

        for (const width of [360, 222, 360]) {
          const onLayout = layout.callbacks.get(row);
          expect(onLayout).toBeDefined();
          act(() => onLayout?.({ nativeEvent: { layout: { width, height: 48 } } }));
          expect(container.firstElementChild).toBe(row);
          expect(container.querySelector('[data-board-control]')).toBe(bulb);
          expect(container.querySelector('[data-tick="true"]')).toBe(tick);
          expect(container.querySelector('[data-mini-player-buttons]')?.getAttribute('data-mini-player-buttons')).toBe(
            'next',
          );
          expect(getMeasuredMiniPlayerBar()).toEqual({ rowWidth: 360, widthBesideName: 68 });
        }
      },
    );

    it('follows viewport resizing before another host measurement arrives', () => {
      layout.width = 222;
      const climb = makeClimb();
      const { container, rerender } = render(<NativeAccessoryClimbRow climb={climb} placement="regular" />);
      for (const windowWidth of [320, 375, 402]) {
        miniPlayer.windowWidth = windowWidth;
        rerender(<NativeAccessoryClimbRow climb={climb} placement="regular" />);
        expect(container.querySelector('[data-board-control]')).not.toBeNull();
        expect(container.querySelector('[data-tick="true"]') !== null).toBe(windowWidth !== 320);
        expect(container.querySelector('[data-mini-player-buttons]') !== null).toBe(windowWidth === 402);
        expect(getMeasuredMiniPlayerBar()?.rowWidth).toBe(windowWidth - 42);
      }
    });

    it('switches to live measurements when a Duo side rail is detected', () => {
      miniPlayer.windowWidth = 466;
      layout.width = 290;
      const climb = makeClimb();
      const { container, rerender } = render(<NativeAccessoryClimbRow climb={climb} placement="regular" />);
      expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
      miniPlayer.verticalTabBar = true;
      rerender(<NativeAccessoryClimbRow climb={climb} placement="regular" />);
      expect(container.querySelector('[data-board-control]')).not.toBeNull();
      expect(container.querySelector('[data-tick="true"]')).toBeNull();
      expect(getMeasuredMiniPlayerBar()?.rowWidth).toBe(290);
    });
  });

  describe("the climber's MiniPlayer buttons (#6940)", () => {
    const buttons = (container: HTMLElement) =>
      container.querySelector('[data-mini-player-buttons]')?.getAttribute('data-mini-player-buttons') ?? null;

    it('adds Next beside the bulb and the tick on an iPhone (~370pt)', () => {
      layout.width = 370;
      const { container } = renderRow('regular');
      expect(buttons(container)).toBe('next');
      expect(container.querySelector('[data-board-control]')).not.toBeNull();
      expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
    });

    it('adds ⏮ ⏭ on an iPad, first', () => {
      miniPlayer.isTablet = true;
      layout.width = 995;
      const { container } = renderRow('regular');
      expect(buttons(container)).toBe('previous,next,favorite');
    });

    describe("Music's iPad layout", () => {
      const nameOf = (container: HTMLElement) =>
        Array.from(container.querySelectorAll('[data-text="true"]')).find(
          (node) => node.textContent === "Alvin's Nuts",
        ) as Element;
      const precedes = (first: Element | null, second: Element | null) =>
        first !== null &&
        second !== null &&
        (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const more = (container: HTMLElement) => container.querySelector('[data-more-menu]');

      it('draws the buttons before the climb, ⋯ before 💡, and a 32pt hero ✓', () => {
        miniPlayer.isTablet = true;
        layout.width = 995;
        const { container } = renderRow('regular');
        const cluster = container.querySelector('[data-mini-player-buttons]');
        expect(precedes(cluster, nameOf(container))).toBe(true);
        // ⋯ is told ⛶ is on the bar too, so it offers no Wall display row.
        expect(more(container)?.getAttribute('data-more-menu')).toBe('previous,next,favorite,wallDisplay');
        expect(precedes(more(container), container.querySelector('[data-board-control]'))).toBe(true);
        const tick = container.querySelector('[data-tick="true"]');
        expect(tick?.getAttribute('data-appearance')).toBe('hero');
        expect(tick?.getAttribute('data-icon-size')).toBe('32');
        expect(nameOf(container).getAttribute('data-variant')).toBe('body');
      });

      it('draws ⛶ Wall display between ⋯ and 💡 on a tablet', () => {
        miniPlayer.isTablet = true;
        layout.width = 995;
        const { container } = renderRow('regular');
        const wall = container.querySelector('[data-wall-display]');
        expect(precedes(more(container), wall)).toBe(true);
        expect(precedes(wall, container.querySelector('[data-board-control]'))).toBe(true);
        // Four fixed frames: ⋯ ⛶ 💡 ✓.
        const pair = container.querySelector('[data-tick="true"]')?.parentElement?.parentElement;
        expect(pair?.children.length).toBe(4);
        expect(pair?.getAttribute('data-width')).toBe('176');
      });

      it('drops the ⛶ frame when the climber switches it off, and ⋯ stands in for it', async () => {
        const { DEFAULT_MINI_PLAYER_BUTTONS } = await import('../../../lib/mini-player-buttons');
        miniPlayer.layout = {
          order: DEFAULT_MINI_PLAYER_BUTTONS.order,
          visible: { ...DEFAULT_MINI_PLAYER_BUTTONS.visible, wallDisplay: false },
        };
        miniPlayer.isTablet = true;
        layout.width = 995;
        const { container } = renderRow('regular');
        expect(container.querySelector('[data-wall-display]')).toBeNull();
        expect(more(container)?.getAttribute('data-more-menu')).toBe('previous,next,favorite');
        const pair = container.querySelector('[data-tick="true"]')?.parentElement?.parentElement;
        expect(pair?.children.length).toBe(3);
      });

      it('offers no ⛶ inline, under the /play route, or on the open Duo', () => {
        miniPlayer.isTablet = true;
        layout.width = 995;
        expect(renderRow('inline').container.querySelector('[data-wall-display]')).toBeNull();
        cleanup();
        miniPlayer.playerRouteUp = true;
        expect(renderRow('regular').container.querySelector('[data-wall-display]')).toBeNull();
        cleanup();
        miniPlayer.playerRouteUp = false;
        miniPlayer.isTablet = false;
        miniPlayer.phoneSplit = true;
        layout.width = 800;
        expect(renderRow('regular').container.querySelector('[data-wall-display]')).toBeNull();
      });

      it('leaves an iPhone as it was: buttons after the climb, no ⋯, a plain ✓, a subheadline name', () => {
        layout.width = 370;
        const { container } = renderRow('regular');
        expect(precedes(nameOf(container), container.querySelector('[data-mini-player-buttons]'))).toBe(true);
        expect(more(container)).toBeNull();
        expect(container.querySelector('[data-tick="true"]')?.getAttribute('data-appearance')).toBe('plain');
        expect(nameOf(container).getAttribute('data-variant')).toBe('subheadline');
      });

      it('offers no ⋯ inline, or while the /play route is up', () => {
        miniPlayer.isTablet = true;
        layout.width = 995;
        expect(more(renderRow('inline').container)).toBeNull();
        cleanup();
        miniPlayer.playerRouteUp = true;
        expect(more(renderRow('regular').container)).toBeNull();
      });

      it("keeps ⋯ on the open Duo's bar while it carries the pane's row", () => {
        miniPlayer.phoneSplit = true;
        layout.width = 800;
        const { container } = renderRow('regular');
        expect(more(container)?.getAttribute('data-more-menu')).toBe('favorite,angle,share');
        expect(container.querySelector('[data-tick="true"]')).toBeNull();
      });
    });

    it("centres in iPad's taller platter with 40pt artwork and the hero ✓ (#7048)", () => {
      miniPlayer.isTablet = true;
      layout.width = 995;
      const { container } = renderRow('regular');
      const row = container.firstElementChild as Element;
      act(() => layout.callbacks.get(row)?.({ nativeEvent: { layout: { width: 995, height: 62 } } }));
      expect(row.getAttribute('data-height')).toBe('100%');
      expect(row.getAttribute('data-padding-end')).toBe('10');
      expectNumericAttribute(getCurrentThumbnail(container), 'data-board-height', 40);
      expect(container.querySelector('[data-tick="true"]')?.getAttribute('data-icon-size')).toBe('32');
    });

    it('keeps the tall geometry when UIKit squeezes the hidden regular row while inline', () => {
      miniPlayer.isTablet = true;
      layout.width = 995;
      const { container } = renderRow('regular');
      const row = container.firstElementChild as Element;
      const onLayout = layout.callbacks.get(row);
      act(() => onLayout?.({ nativeEvent: { layout: { width: 995, height: 62 } } }));
      act(() => onLayout?.({ nativeEvent: { layout: { width: 995, height: 40 } } }));
      expect(row.getAttribute('data-padding-end')).toBe('10');
      expectNumericAttribute(getCurrentThumbnail(container), 'data-board-height', 40);
    });

    it("keeps a wide bar's buttons and ⋯ rows through the inline squeeze, and narrows on a new window", () => {
      miniPlayer.isTablet = true;
      miniPlayer.windowWidth = 1210;
      layout.width = 995;
      const { container, rerender } = renderRow('regular');
      const row = container.firstElementChild as Element;
      const onLayout = layout.callbacks.get(row);
      expect(buttons(container)).toBe('previous,next,favorite');
      // Inline, UIKit squeezes this hidden row to the collapsed bar's width.
      act(() => onLayout?.({ nativeEvent: { layout: { width: 300, height: 62 } } }));
      expect(buttons(container)).toBe('previous,next,favorite');
      act(() => onLayout?.({ nativeEvent: { layout: { width: 995, height: 62 } } }));
      expect(buttons(container)).toBe('previous,next,favorite');
      // A narrow window really is narrower: the bar counts from it.
      miniPlayer.windowWidth = 400;
      layout.width = 300;
      rerender(
        <NativeAccessoryClimbRow climb={queue.state.currentClimbQueueItem?.climb as Climb} placement="regular" />,
      );
      act(() => layout.callbacks.get(row)?.({ nativeEvent: { layout: { width: 300, height: 62 } } }));
      expect(buttons(container)).toBeNull();
    });

    it('closes the gap between ⋯ and ✓ when no board is bound', () => {
      miniPlayer.isTablet = true;
      layout.width = 995;
      connection.state = { ...connection.state, bluetooth: null };
      const { container } = renderRow('regular');
      const tick = container.querySelector('[data-tick="true"]');
      const pair = tick?.parentElement?.parentElement;
      // ⋯ ⛶ ✓, with no empty bulb frame between ⛶ and ✓.
      expect(pair?.children.length).toBe(3);
      expect(pair?.firstElementChild?.querySelector('[data-more-menu]')).not.toBeNull();
      expect(pair?.children[1]?.querySelector('[data-wall-display]')).not.toBeNull();
      expect(pair?.getAttribute('data-width')).toBe('132');
      expect(pair?.parentElement?.getAttribute('data-width')).toBe('132');
    });

    it("keeps an iPad's collapsed platter on the short geometry", () => {
      miniPlayer.isTablet = true;
      const { container } = renderRow('inline');
      expect(container.firstElementChild?.getAttribute('data-padding-end')).toBe('8');
      expectNumericAttribute(getCurrentThumbnail(container), 'data-board-height', 32);
    });

    it('adds nothing inline or on a narrow platter', () => {
      miniPlayer.isTablet = true;
      expect(buttons(renderRow('inline').container)).toBeNull();
      layout.width = 290;
      miniPlayer.isTablet = false;
      miniPlayer.verticalTabBar = true;
      expect(buttons(renderRow('regular').container)).toBeNull();
    });

    it("carries the open Duo pane's covered small row instead of ⏮ ⏭ 💡 ✓, which the pane shows above", () => {
      miniPlayer.phoneSplit = true;
      layout.width = 800;
      const { container } = renderRow('regular');
      // Kilter's default player row: ♡ 40° ··· ⬆ (☰ leads the big row).
      expect(buttons(container)).toBe('favorite,angle,share');
      expect(container.querySelector('[data-board-control]')).toBeNull();
      expect(container.querySelector('[data-tick="true"]')).toBeNull();
    });

    it("follows the climber's player buttons on the open Duo, not their MiniPlayer ones", () => {
      miniPlayer.phoneSplit = true;
      layout.width = 800;
      miniPlayer.playerButtons = {
        order: ['share', 'queue', 'favorite', 'angle', 'mirror'],
        visible: { mirror: true, favorite: true, angle: false, share: true, queue: true },
      };
      // Queue takes the pane's big leading slot, so the bar covers Share and the heart.
      expect(buttons(renderRow('regular').container)).toBe('share,favorite');
    });

    it('leaves out what a signed-out climber, a draft or a fixed-angle board cannot use', () => {
      miniPlayer.phoneSplit = true;
      layout.width = 800;
      miniPlayer.signedIn = false;
      miniPlayer.angleAdjustable = false;
      const current = queue.state.currentClimbQueueItem as ClimbQueueItem;
      queue.state.currentClimbQueueItem = { ...current, climb: { ...current.climb, is_draft: true } };
      expect(buttons(renderRow('regular').container)).toBeNull();
    });

    it.each([
      ['shows a preview, whose buttons would act on another climb', () => (miniPlayer.panePreview = true)],
      ['has its controls above the board, where nothing is covered', () => (miniPlayer.position = 'above')],
    ])('keeps only the bulb and the tick on the open Duo while the pane %s', (_label, arrange) => {
      miniPlayer.phoneSplit = true;
      layout.width = 800;
      arrange();
      const { container } = renderRow('regular');
      expect(buttons(container)).toBeNull();
      expect(container.querySelector('[data-board-control]')).not.toBeNull();
      expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
    });

    it('leaves Angle out while the /play route is up, so it never leaves a gap', () => {
      miniPlayer.isTablet = true;
      layout.width = 995;
      miniPlayer.playerRouteUp = true;
      miniPlayer.layout = {
        order: ['next', 'previous', 'mirror', 'favorite', 'queue', 'share', 'angle'],
        visible: { next: true, previous: true, mirror: false, favorite: false, queue: false, share: true, angle: true },
      };
      expect(buttons(renderRow('regular').container)).toBe('previous,next,share');
    });

    it('places the extra buttons the climber switched on, on an iPad', () => {
      miniPlayer.isTablet = true;
      layout.width = 995;
      miniPlayer.layout = {
        order: ['next', 'previous', 'mirror', 'favorite', 'queue', 'share', 'angle'],
        visible: { next: true, previous: true, mirror: true, favorite: true, queue: true, share: true, angle: true },
      };
      // Kilter can't mirror; ⏮ ⏭ lead and the rest keep the climber's order.
      expect(buttons(renderRow('regular').container)).toBe('previous,next,favorite,queue,share,angle');
    });

    describe('in a timed workout block', () => {
      const workoutButtons = (container: HTMLElement) =>
        container.querySelector('[data-workout-buttons]')?.getAttribute('data-workout-buttons') ?? null;
      const inBlock = () => {
        workoutGate.inTimedBlock = true;
        workoutGate.shown = { target: { queueItemUuid: 'climb-1' }, wallLeftAtMs: null };
      };

      it('shows Fell, Sent and the bulb on an iPhone: the tick and Next step aside', () => {
        inBlock();
        layout.width = 370;
        const { container } = renderRow('regular');
        expect(workoutButtons(container)).toBe('fell,sent');
        expect(buttons(container)).toBeNull();
        expect(container.querySelector('[data-board-control]')).not.toBeNull();
        expect(container.querySelector('[data-tick="true"]')).toBeNull();
      });

      it("shows Fell, Sent, the bulb and the tick on an iPad, with the climber's buttons aside", () => {
        inBlock();
        miniPlayer.isTablet = true;
        layout.width = 995;
        const { container } = renderRow('regular');
        expect(workoutButtons(container)).toBe('fell,sent');
        expect(buttons(container)).toBeNull();
        expect(container.querySelector('[data-board-control]')).not.toBeNull();
        expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
      });

      it('keeps Sent alone when the tab bar is minimized', () => {
        inBlock();
        const { container } = renderRow('inline');
        expect(workoutButtons(container)).toBe('sent');
        expect(container.querySelector('[data-board-control]')).toBeNull();
        expect(container.querySelector('[data-tick="true"]')).toBeNull();
      });

      it("carries Fell and Sent over the open Duo pane's row, and nothing else", () => {
        inBlock();
        miniPlayer.phoneSplit = true;
        layout.width = 800;
        const { container } = renderRow('regular');
        expect(workoutButtons(container)).toBe('fell,sent');
        expect(buttons(container)).toBeNull();
        expect(container.querySelector('[data-board-control]')).toBeNull();
      });

      it("gives an iPhone's third slot to the tick when no board is bound, not to an empty bulb", () => {
        inBlock();
        connection.state = { ...connection.state, bluetooth: null };
        layout.width = 370;
        const { container } = renderRow('regular');
        expect(workoutButtons(container)).toBe('fell,sent');
        expect(container.querySelector('[data-board-control]')).toBeNull();
        expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
      });

      it("tells the open Duo's pane it carries its Fell / Sent, from the open placement only", () => {
        inBlock();
        miniPlayer.phoneSplit = true;
        layout.width = 800;
        const carried = renderHook(() => useBarCarriesPaneWorkoutRow());
        const inline = renderRow('inline');
        expect(carried.result.current).toBe(false);
        const regular = renderRow('regular');
        expect(carried.result.current).toBe(true);
        regular.unmount();
        expect(carried.result.current).toBe(false);
        inline.unmount();
      });

      it('keeps the step-aside bar while the Duo pane shows a preview', () => {
        inBlock();
        miniPlayer.phoneSplit = true;
        miniPlayer.panePreview = true;
        layout.width = 800;
        const { container } = renderRow('regular');
        expect(workoutButtons(container)).toBeNull();
        expect(container.querySelector('[data-board-control]')).not.toBeNull();
        expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
      });

      it("drops ⏮ ⏭ but keeps the climber's other buttons where the climber can't log the block", () => {
        workoutGate.inTimedBlock = true;
        miniPlayer.isTablet = true;
        layout.width = 995;
        const { container } = renderRow('regular');
        expect(workoutButtons(container)).toBeNull();
        expect(buttons(container)).toBe('favorite');
      });

      it('swaps back to the usual bar when the block ends, without remounting the row', () => {
        inBlock();
        layout.width = 370;
        const { container, rerender } = renderRow('regular');
        const row = container.firstElementChild;
        workoutGate.inTimedBlock = false;
        workoutGate.shown = null;
        rerender(<NativeAccessoryClimbRow climb={queue.state.currentClimbQueueItem!.climb} placement="regular" />);
        expect(container.firstElementChild).toBe(row);
        expect(workoutButtons(container)).toBeNull();
        expect(buttons(container)).toBe('next');
        expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
      });
    });

    describe('Mirror', () => {
      const tensionBoard: BoardConfig = { boardName: 'tension', layoutId: 10, sizeId: 1, setIds: '1,2', angle: 40 };

      it('is on by default on an iPad, on a board that mirrors: ⏮ ⏭ · ⇄ ♡', () => {
        drawer.boardConfig = tensionBoard;
        miniPlayer.isTablet = true;
        layout.width = 995;
        expect(buttons(renderRow('regular').container)).toBe('previous,next,mirror,favorite');
      });

      it('takes no place on Kilter, nor on the Tension layout that cannot mirror', () => {
        miniPlayer.isTablet = true;
        layout.width = 995;
        const kilter = renderRow('regular');
        expect(buttons(kilter.container)).toBe('previous,next,favorite');
        kilter.unmount();
        drawer.boardConfig = { ...tensionBoard, layoutId: 11 };
        expect(buttons(renderRow('regular').container)).toBe('previous,next,favorite');
      });

      it("claims its place in the climber's order on an iPhone", () => {
        drawer.boardConfig = tensionBoard;
        layout.width = 370;
        const defaults = renderRow('regular');
        expect(buttons(defaults.container)).toBe('next');
        defaults.unmount();
        miniPlayer.layout = {
          order: ['mirror', 'next', 'previous', 'favorite', 'queue', 'share', 'angle'],
          visible: {
            next: true,
            previous: true,
            mirror: true,
            favorite: false,
            queue: false,
            share: false,
            angle: false,
          },
        };
        expect(buttons(renderRow('regular').container)).toBe('mirror');
      });

      it("is carried on the open Duo only when the player's covered small row has it", () => {
        drawer.boardConfig = tensionBoard;
        miniPlayer.phoneSplit = true;
        layout.width = 800;
        // ⇄ leads the pane's big row by default, in view above the bar.
        const defaults = renderRow('regular');
        expect(buttons(defaults.container)?.split(',') ?? []).not.toContain('mirror');
        defaults.unmount();
        // With the queue leading instead, ⇄ sits in the small row the bar covers.
        miniPlayer.playerButtons = {
          order: ['queue', 'mirror', 'favorite', 'angle', 'share'],
          visible: { mirror: true, favorite: true, angle: true, share: true, queue: true },
        };
        expect(buttons(renderRow('regular').container)?.split(',')).toContain('mirror');
      });

      it.each([
        ['shows a preview', () => (miniPlayer.panePreview = true)],
        ['has its controls above the board', () => (miniPlayer.position = 'above')],
      ])('is not carried on the open Duo while the pane %s', (_label, arrange) => {
        drawer.boardConfig = tensionBoard;
        miniPlayer.phoneSplit = true;
        layout.width = 800;
        miniPlayer.playerButtons = {
          order: ['queue', 'mirror', 'favorite', 'angle', 'share'],
          visible: { mirror: true, favorite: true, angle: true, share: true, queue: true },
        };
        arrange();
        expect(buttons(renderRow('regular').container)).toBeNull();
      });
    });

    it("adds them on the open Duo while a screen's own content fills the pane", () => {
      miniPlayer.phoneSplit = true;
      miniPlayer.paneTaken = true;
      layout.width = 800;
      expect(buttons(renderRow('regular').container)).toBe('previous,next,favorite');
    });

    it("keeps today's bar for a climber who switched them off", () => {
      miniPlayer.isTablet = true;
      layout.width = 995;
      miniPlayer.layout = {
        order: ['next', 'previous', 'mirror', 'favorite', 'queue', 'share', 'angle'],
        visible: {
          next: false,
          previous: false,
          mirror: false,
          favorite: false,
          queue: false,
          share: false,
          angle: false,
        },
      };
      expect(buttons(renderRow('regular').container)).toBeNull();
    });
  });

  describe('the connection mark on the thumbnail', () => {
    const badge = (container: HTMLElement) =>
      container.querySelector('[data-testid="accessory-connection-badge"]') as HTMLElement | null;

    it.each(['regular', 'inline'] as const)('marks a lit board you hold with an amber bulb (%s)', (placement) => {
      connection.state.inAppBoardConnection = 'connectedByMe';
      const { container } = renderRow(placement);
      const icon = badge(container)?.querySelector('[data-icon]');
      expect(icon?.getAttribute('data-icon')).toBe('lightbulb.fill');
      expect(icon?.getAttribute('data-icon-color')).toBe('#FBBF24');
      expect(badge(container)?.closest('[data-accessory-play-link]')).not.toBeNull();
    });

    it('marks a board with no lights with a pin in the brand tone, never amber', () => {
      connection.state.inAppBoardConnection = 'connectedByMe';
      connection.state.ledless = true;
      const { container } = renderRow('inline');
      const icon = badge(container)?.querySelector('[data-icon]');
      expect(icon?.getAttribute('data-icon')).toBe('pin.fill');
      expect(icon?.getAttribute('data-icon-color')).toBe('#6D28D9');
    });

    it("marks a teammate's hold with a grey person, not your bulb", () => {
      connection.state.inAppBoardConnection = 'heldByPeer';
      const { container } = renderRow('inline');
      const icon = badge(container)?.querySelector('[data-icon]');
      expect(icon?.getAttribute('data-icon')).toBe('person.fill');
      expect(icon?.getAttribute('data-icon-color')).toBe('#777777');
    });

    it('hides the mark while the board is free, but keeps it mounted', () => {
      const { container } = renderRow('inline');
      // Mounted (UIKit snapshots the platter), but nothing to see.
      expect(badge(container)).not.toBeNull();
      expect(badge(container)?.getAttribute('data-opacity')).toBe('0');
    });

    it('shows the mark at full opacity once someone holds the board', () => {
      connection.state.inAppBoardConnection = 'connectedByMe';
      const { container } = renderRow('inline');
      expect(badge(container)?.getAttribute('data-opacity')).toBe('');
    });
  });

  describe("the climb link's spoken connection", () => {
    const link = (container: HTMLElement) => container.querySelector('[data-accessory-play-link]');

    it('says who holds the board on the collapsed platter, where only the mark shows it', () => {
      connection.state.inAppBoardConnection = 'connectedByMe';
      const { container } = renderRow('inline');
      expect(link(container)?.getAttribute('data-a11y-value')).toBe('ble.barControl.connectedLabel');
    });

    it('names the teammate holding the wall', () => {
      connection.state.inAppBoardConnection = 'heldByPeer';
      connection.state.holderDisplayName = 'Alex';
      const { container } = renderRow('inline');
      expect(link(container)?.getAttribute('data-a11y-value')).toBe('ble.barControl.peerLabel');
    });

    it('says nothing extra while the board is free, or on the open platter where the bulb speaks', () => {
      const free = renderRow('inline');
      expect(link(free.container)?.getAttribute('data-a11y-value')).toBe('');
      free.unmount();
      connection.state.inAppBoardConnection = 'connectedByMe';
      const open = renderRow('regular');
      expect(link(open.container)?.getAttribute('data-a11y-value')).toBe('');
    });
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
      <NativeAccessoryClimbRow climb={makeClimb({ uuid: 'wall', name: 'On The Wall' })} placement="regular" />,
    );

    expect(container.textContent).toContain('On The Wall');
    expect(container.querySelector('[data-tick="true"]')).not.toBeNull();
  });

  // #5954: a draft is left out of the Climbs list, so the platter says why the
  // climb it is showing is not in it.
  it('marks a draft climb with the Draft chip', () => {
    const { container } = render(<NativeAccessoryClimbRow climb={makeClimb({ is_draft: true })} placement="regular" />);
    const chip = container.querySelector('[data-label="createClimbForm.draftBadge"]');
    expect(chip?.textContent).toBe('createClimbForm.draftBadge');
  });

  it('leaves a published climb, and one that does not say, without the chip', () => {
    for (const isDraft of [false, null, undefined]) {
      const { container, unmount } = render(
        <NativeAccessoryClimbRow climb={makeClimb({ is_draft: isDraft })} placement="regular" />,
      );
      expect(container.querySelector('[data-label="createClimbForm.draftBadge"]')).toBeNull();
      unmount();
    }
  });

  // The View options preview uses the same regular capacity as the real bar.
  describe('publishing the measured bar to the preview', () => {
    it('publishes the open platter width and what the row spends beside the name', () => {
      miniPlayer.verticalTabBar = true;
      layout.width = 290;
      renderRow('regular');
      expect(getMeasuredMiniPlayerBar()).toEqual({ rowWidth: 290, widthBesideName: 68 });
    });

    it('does not publish from the collapsed platter', () => {
      layout.width = 120;
      renderRow('inline');
      expect(getMeasuredMiniPlayerBar()).toBeNull();
    });
  });
});
