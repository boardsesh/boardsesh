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
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { Climb as SchemaClimb } from '@boardsesh/shared-schema';

const ctrl = vi.hoisted(() => ({
  // The queue's current climb and a view-only preview's, for the row highlight.
  activeClimbUuid: null as string | null,
  previewedClimbUuid: null as string | null,
  back: vi.fn(),
  setOptions: vi.fn(),
  navigation: null as unknown as { setOptions: (options: Record<string, unknown>) => void },
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  fontScale: 1,
  playNext: vi.fn(),
  openAddToPlaylist: vi.fn(),
  openClimbActions: vi.fn(),
  // The scroll-stage reaction (0 hero in view, 1 hero gone, 2 filter bar gone),
  // so a test can scroll the header away.
  scrollStageReaction: null as null | ((stage: number, previousStage: number | null) => void),
  // FlashList's maintainVisibleContentPosition, as the view last passed it.
  maintainVisibleContentPosition: undefined as unknown,
}));

type CapturedClimbListRowProps = {
  climb: SchemaClimb;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  unsupported?: boolean;
  showProgress?: boolean;
  onPress?: (climb: { uuid: string; name: string }) => void;
  onPlayNext?: (climb: SchemaClimb) => void;
  onOpenPlaylist?: (climb: SchemaClimb) => void;
  selected?: boolean;
};

type CapturedPlaylistEditClimbRowProps = {
  climb: Climb;
  minimumHeight?: number;
  board: {
    boardName: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
    angle: number;
  };
};

ctrl.navigation = { setOptions: (options: Record<string, unknown>) => ctrl.setOptions(options) };

const capturedClimbRows = vi.hoisted(() => [] as CapturedClimbListRowProps[]);
const capturedEditRows = vi.hoisted(() => [] as CapturedPlaylistEditClimbRowProps[]);

// ── React Native ──────────────────────────────────────────────────────────────
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale: ctrl.fontScale }),
  View: ({
    children,
    pointerEvents,
    onLayout,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    pointerEvents?: string;
    onLayout?: (e: unknown) => void;
    accessibilityLabel?: string;
    style?: unknown;
  }) => {
    const attrs: Record<string, unknown> = {};
    if (pointerEvents) attrs['data-pointer-events'] = pointerEvents;
    if (onLayout) attrs['data-has-layout'] = 'true';
    if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
    // Where a view starts and how wide it is: enough to tell a thumbnail-sized
    // frame, and a separator's inset.
    const { marginStart, width, minHeight, position, top } = Object.assign({}, ...[style].flat(10).filter(Boolean)) as {
      position?: string;
      top?: number;
      marginStart?: number;
      width?: number | string;
      minHeight?: number;
    };
    if (marginStart !== undefined) attrs['data-margin-start'] = marginStart;
    if (width !== undefined) attrs['data-width'] = width;
    if (minHeight !== undefined) attrs['data-min-height'] = minHeight;
    if (position !== undefined) attrs['data-position'] = position;
    if (top !== undefined) attrs['data-top'] = top;
    return createElement('div', attrs, children);
  },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  RefreshControl: ({ refreshing, onRefresh }: { refreshing?: boolean; onRefresh?: () => void }) =>
    createElement('button', { 'data-refresh-control': String(!!refreshing), onClick: onRefresh }, 'refresh'),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (s: Record<string, unknown>) => s,
    absoluteFill: {},
    hairlineWidth: 1,
  },
}));

// ── Reanimated ────────────────────────────────────────────────────────────────
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode; style?: unknown }) =>
      createElement('div', { 'data-animated-view': 'true' }, children),
  },
  useAnimatedStyle: () => ({}),
  useSharedValue: (v: number) => ({ value: v }),
  // useAnimatedReaction runs on a worklet thread — no-op in jsdom; the
  // component initialises `collapsed` to false via useState, which is what the
  // tests assert against.
  useAnimatedReaction: (_prepare: () => number, react: (stage: number, previousStage: number | null) => void) => {
    ctrl.scrollStageReaction = react;
  },
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  interpolate: (v: number) => v,
  Extrapolation: { CLAMP: 'CLAMP' },
}));

// ── Expo / third-party ────────────────────────────────────────────────────────
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ colors, children }: { colors: string[]; children?: ReactNode }) =>
    createElement('div', { 'data-gradient': JSON.stringify(colors) }, children ?? null),
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
    ListFooterComponent,
    onEndReached,
    refreshControl,
    maintainVisibleContentPosition,
  }: {
    maintainVisibleContentPosition?: unknown;
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    onEndReached?: () => void;
    refreshControl?: ReactNode;
  }) => {
    ctrl.maintainVisibleContentPosition = maintainVisibleContentPosition;
    const rowNodes = data?.map((item, index) => {
      const key =
        typeof item === 'object' && item !== null && 'uuid' in item ? String((item as { uuid?: unknown }).uuid) : index;
      return renderItem ? createElement('div', { key }, renderItem({ item, index })) : null;
    });
    return createElement(
      'div',
      { 'data-list': 'true', onClick: onEndReached },
      refreshControl ?? null,
      ListHeaderComponent ?? null,
      data?.length === 0 ? (ListEmptyComponent ?? null) : null,
      rowNodes ?? null,
      ListFooterComponent ?? null,
    );
  },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: ctrl.back }),
  // Stable, like the real navigation object, so an effect keyed on it settles.
  useNavigation: () => ctrl.navigation,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'editClimbs.removeAria' && typeof opts?.name === 'string') {
        return `${key}:${opts.name}`;
      }
      return key;
    },
  }),
}));

// ── Theme / providers ─────────────────────────────────────────────────────────
// Layout/action tests stub the climb rows and omit query/auth providers; tick
// loading is exercised with the real provider in climb-progress-provider.test.tsx.
vi.mock('../../../providers/climb-progress-provider', () => ({
  ClimbProgressProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: {
      label: '#000000',
      secondaryLabel: '#666666',
      tertiaryLabel: '#999999',
      error: '#ff3b30',
      fill: '#eeeeee',
      background: '#ffffff',
      secondaryBackground: '#f2f2f2',
      tertiaryBackground: '#e5e5e5',
    },
    brandColors: { primary: '#6D28D9' },
    opacity: { disabled: 0.5 },
  }),
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  usePreviewedClimbUuid: () => ctrl.previewedClimbUuid,
  useDrawerHost: () => ({
    boardConfig: null,
    openClimbActions: ctrl.openClimbActions,
    openAddToPlaylist: ctrl.openAddToPlaylist,
  }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ playNext: ctrl.playNext }),
  useActiveClimbUuid: () => ctrl.activeClimbUuid,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queued-climb-uuid' }));

vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
// The collapsed-bar ProgressiveBlur reads the surface mode; 'blur' renders its iOS
// blur path and short-circuits the native a11y / glass-capability hooks.
vi.mock('../../../hooks/use-effective-surface-mode', () => ({ useEffectiveSurfaceMode: () => 'blur' }));

vi.mock('../../../theme/layout', () => ({ glassSize: { standard: 48, capsule: 36, hero: 56 } }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 12: 48 },
  borderRadius: { lg: 12, xl: 24 },
}));
vi.mock('../../../theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `${color}|${alpha}`,
}));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#ffffff' },
}));

// ── Leaf components ───────────────────────────────────────────────────────────
vi.mock('../../Text', () => ({
  Text: ({ children, variant, color }: { children?: ReactNode; variant?: string; color?: string }) =>
    createElement('span', { 'data-variant': variant ?? '', 'data-color': color }, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name, size }: { name: string; size?: number }) =>
    createElement('span', { 'data-icon': name, 'data-size': size }),
}));

vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: ({ size }: { size?: string }) => createElement('div', { 'data-spinner': size ?? 'default' }),
}));

vi.mock('../../ClimbListRow', () => ({
  ClimbListRow: (props: CapturedClimbListRowProps) => {
    capturedClimbRows.push(props);
    return createElement(
      'button',
      {
        'data-climb-row': props.climb.uuid,
        'data-board-name': props.boardName,
        'data-layout-id': String(props.layoutId),
        'data-unsupported': props.unsupported ? 'true' : 'false',
        onClick: () => props.onPress?.(props.climb),
      },
      props.climb.name,
    );
  },
}));

// Button pulls in react-native-paper + expo-modules-core; stub it to a plain
// button so the board-mismatch banner can render in jsdom.
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { 'data-button': 'true', onClick: onPress }, title),
}));

vi.mock('../../ClimbListRowSkeleton', () => ({
  ClimbListRowSkeleton: () => createElement('div', { 'data-skeleton-row': 'true' }),
}));

// icon-map is pure data but pulls in expo-symbols types via Icon's import chain;
// stub it so the component's `type IconName` import resolves without RN deps.
vi.mock('../../icon-map', () => ({ iconMap: {} }));

// react-native-paper drags in expo-modules-core at import time; stub the only
// pieces the Material branch uses so the suite can load.
vi.mock('react-native-paper', () => {
  const Header = ({
    children,
    style,
    statusBarHeight,
  }: {
    children?: ReactNode;
    style?: unknown;
    statusBarHeight?: number;
  }) => {
    const { position, height } = Object.assign({}, ...[style].flat(10).filter(Boolean)) as {
      position?: string;
      height?: number;
    };
    const attrs: Record<string, unknown> = { 'data-appbar': 'true' };
    if (position !== undefined) attrs['data-appbar-style-position'] = position;
    if (height !== undefined) attrs['data-appbar-height'] = height;
    if (statusBarHeight !== undefined) attrs['data-status-bar-height'] = statusBarHeight;
    return createElement('div', attrs, children);
  };
  const BackAction = ({ onPress, accessibilityLabel }: { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { 'data-icon': 'back', onClick: onPress, 'aria-label': accessibilityLabel });
  const Content = ({ title }: { title?: ReactNode }) => createElement('span', { 'data-appbar-title': 'true' }, title);
  const Action = ({
    icon,
    onPress,
    accessibilityLabel,
  }: {
    icon?: string;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { 'data-appbar-action': icon, onClick: onPress, 'aria-label': accessibilityLabel });
  return { Appbar: { Header, BackAction, Content, Action } };
});

vi.mock('../../GlassIconButton', () => ({
  GlassIconButton: ({
    iconName,
    onPress,
    accessibilityLabel,
  }: {
    iconName: string;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { 'data-icon': iconName, onClick: onPress, 'aria-label': accessibilityLabel }),
}));

// GlassSurface pulls in @react-native-community/blur + expo-glass-effect at
// import time; stub it to a plain div that still renders its children (the
// collapsed-bar title).
vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-glass-surface': 'true' }, children ?? null),
}));

vi.mock('../PlaylistAddToQueueRow', () => ({
  PlaylistAddToQueueRow: ({
    onQueue,
    pendingPlacement,
    count,
  }: {
    onQueue: (placement: 'next' | 'end') => void;
    pendingPlacement: 'next' | 'end' | null;
    count?: number;
  }) =>
    createElement('button', {
      'data-add-to-queue-row': 'true',
      'data-pending': String(pendingPlacement),
      'data-count': count === undefined ? 'none' : String(count),
      onClick: () => onQueue('next'),
    }),
}));

vi.mock('../PlaylistBoardBackdrop', () => ({
  PlaylistBoardBackdrop: ({ boardType }: { boardType: string }) => createElement('div', { 'data-backdrop': boardType }),
}));

// Edit-mode helpers pull in react-native-gesture-handler / reanimated worklets
// that don't parse under jsdom; the view defaults editMode off, so stub them.
vi.mock('../use-playlist-drag', () => ({
  usePlaylistDrag: () => ({
    isDragging: false,
    controls: { shared: {}, onRowHeight: () => {}, makeHandleGesture: () => ({}) },
  }),
}));
vi.mock('../PlaylistEditClimbRow', () => ({
  PlaylistEditClimbRow: (props: CapturedPlaylistEditClimbRowProps) => {
    capturedEditRows.push(props);
    return createElement('div', { 'data-edit-climb-row': props.climb.uuid });
  },
}));

// Use real playlist-gradient and playlist-colors (pure TS, no RN imports).

// ── Subject ───────────────────────────────────────────────────────────────────
import { PlaylistDetailView, type PlaylistDetailViewProps } from '../PlaylistDetailView';
import {
  resetClimbRowDisplayForTests,
  setClimbRowField,
  applyClimbRowPreset,
} from '../../../lib/climb-row-display-preference';
import { useButtonSurface } from '../../Button.surface';

// ── Helpers ───────────────────────────────────────────────────────────────────
function lastHeaderOptions(): Record<string, unknown> {
  const options = ctrl.setOptions.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
  if (!options) throw new Error('navigation.setOptions was never called');
  return options;
}

const CLIMB: Climb = {
  uuid: 'abc-123',
  name: 'Test Route',
  setter_username: 'tester',
  frames: '',
  angle: 40,
  ascensionist_count: 5,
  difficulty: '10',
  quality_average: '3.0',
  stars: 3,
  difficulty_error: '0',
  benchmark_difficulty: null,
};

const KILTER_CLIMB: Climb = {
  ...CLIMB,
  uuid: 'kilter-row',
  name: 'Kilter Row',
  boardType: 'kilter',
  layoutId: 1,
  angle: 40,
};

const TENSION_CLIMB: Climb = {
  ...CLIMB,
  uuid: 'tension-row',
  name: 'Tension Row',
  boardType: 'tension',
  layoutId: 9,
  angle: 35,
};

const UNKNOWN_BOARD_CLIMB: Climb = {
  ...CLIMB,
  uuid: 'unknown-board-row',
  name: 'Unknown Board Row',
  boardType: 'unknown-board',
  layoutId: 999,
  angle: 40,
};

function makeProps(overrides: Partial<PlaylistDetailViewProps> = {}): PlaylistDetailViewProps {
  return {
    hero: {
      name: 'My Playlist',
      climbCount: 12,
      color: '#8C4A52',
    },
    climbs: [],
    renderBoard: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    onActivateClimb: vi.fn(),
    emptyMessage: 'No climbs yet',
    ...overrides,
  };
}

describe('PlaylistDetailView', () => {
  beforeEach(() => {
    ctrl.back.mockClear();
    ctrl.setOptions.mockClear();
    ctrl.playNext.mockClear();
    ctrl.openAddToPlaylist.mockClear();
    ctrl.openClimbActions.mockClear();
    ctrl.variant = 'liquidGlass';
    ctrl.fontScale = 1;
    capturedClimbRows.length = 0;
    ctrl.activeClimbUuid = null;
    ctrl.previewedClimbUuid = null;
    capturedEditRows.length = 0;
    resetClimbRowDisplayForTests();
  });

  // ── Navigation ──────────────────────────────────────────────────────────────

  // HIG Navigation bars: the native header and its system back button (long-press
  // history, edge swipe), transparent over the hero — not a hand-built chevron.
  it('shows the native header, transparent over the hero, instead of a back FAB', () => {
    const { container } = render(<PlaylistDetailView {...makeProps()} />);

    expect(lastHeaderOptions()).toMatchObject({ headerShown: true, headerTransparent: true, title: 'My Playlist' });
    expect(container.querySelector('[data-icon="back"]')).toBeNull();
  });

  it('draws no native title over the hero, which already carries the name', () => {
    render(<PlaylistDetailView {...makeProps()} />);

    const headerTitle = lastHeaderOptions().headerTitle as () => ReactNode;
    const customTitle = headerTitle();
    // Native-stack uses the screen title whenever the custom renderer returns
    // null. Exercise that fallback instead of only checking the callback.
    const { container } = render(createElement('div', null, customTitle ?? (lastHeaderOptions().title as string)));
    expect(customTitle).not.toBeNull();
    expect(container.textContent).toBe('');
    expect(lastHeaderOptions().headerLargeTitle).toBe(false);
  });

  // ── Screenshot-mode page cap ────────────────────────────────────────────────
  //
  // Both lists behind this view page through @boardsesh/playlists-react, which
  // web consumes and which must not read a mobile build flag — so unlike the
  // app's own infinite queries, `hasNextPage` stays TRUE here and the cap lives
  // in this component's own end-reach handler.

  describe('screenshot-mode page cap', () => {
    const originalScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;

    afterEach(() => {
      if (originalScreenshotMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
      else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = originalScreenshotMode;
    });

    it('pages on end-reach in a normal build', () => {
      delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
      const fetchNextPage = vi.fn();
      const { container } = render(<PlaylistDetailView {...makeProps({ hasNextPage: true, fetchNextPage })} />);
      fireEvent.click(container.querySelector('[data-list="true"]') as HTMLElement);
      expect(fetchNextPage).toHaveBeenCalledTimes(1);
    });

    it('never pages past the first page in screenshot mode', () => {
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
      const fetchNextPage = vi.fn();
      // hasNextPage is deliberately true: the shared hook still reports more,
      // which is exactly why the handler has to be the thing that stops.
      const { container } = render(<PlaylistDetailView {...makeProps({ hasNextPage: true, fetchNextPage })} />);
      fireEvent.click(container.querySelector('[data-list="true"]') as HTMLElement);
      expect(fetchNextPage).not.toHaveBeenCalled();
    });
  });

  // ── Action threading ────────────────────────────────────────────────────────

  it('hosts the expanded actions as the native header trailing item', () => {
    const actions = vi.fn((collapsed: boolean) =>
      createElement('span', { 'data-action-collapsed': String(collapsed) }, 'action'),
    );
    render(<PlaylistDetailView {...makeProps({ actions })} />);

    const headerRight = lastHeaderOptions().headerRight as () => ReactNode;
    const { container } = render(createElement('div', null, headerRight()));
    expect(actions).toHaveBeenCalledWith(false);
    expect(container.querySelector('[data-action-collapsed="false"]')).not.toBeNull();
  });

  // HIG Materials: the iOS 26 bar item is already a glass capsule, so the region
  // is declared glass and the controls inside drop their own.
  it('declares the header trailing item a glass region', () => {
    function SurfaceProbe() {
      return createElement('span', { 'data-surface': useButtonSurface() });
    }
    render(<PlaylistDetailView {...makeProps({ actions: () => createElement(SurfaceProbe) })} />);

    const headerRight = lastHeaderOptions().headerRight as () => ReactNode;
    const { container } = render(createElement('div', null, headerRight()));
    expect(container.querySelector('[data-surface]')?.getAttribute('data-surface')).toBe('glass');
  });

  it('sets no trailing item when actions prop is omitted', () => {
    render(<PlaylistDetailView {...makeProps()} />);
    expect(lastHeaderOptions().headerRight).toBeUndefined();
  });

  it('does not re-set the header options on a plain re-render', () => {
    const actions = vi.fn(() => createElement('span', null, 'action'));
    const props = makeProps({ actions });
    const { rerender } = render(<PlaylistDetailView {...props} />);
    const callsAfterMount = ctrl.setOptions.mock.calls.length;

    rerender(<PlaylistDetailView {...props} />);
    expect(ctrl.setOptions.mock.calls.length).toBe(callsAfterMount);
  });

  // ── Play in the glass header (#6667) ───────────────────────────────────────

  describe('glass header Play', () => {
    function headerRightNode(): HTMLElement {
      const headerRight = lastHeaderOptions().headerRight as (() => ReactNode) | undefined;
      if (!headerRight) throw new Error('no headerRight');
      return render(createElement('div', null, headerRight())).container;
    }

    it('plays the list from its first row, as a deliberate start', () => {
      const onActivateClimb = vi.fn();
      const second = { ...CLIMB, uuid: 'second-row' };
      render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB, second], onActivateClimb })} />);

      const play = headerRightNode().querySelector('[data-icon="play.fill"]') as HTMLElement;
      expect(play).not.toBeNull();
      expect(play.getAttribute('aria-label')).toBe('detail.activateAll');
      fireEvent.click(play);
      expect(onActivateClimb).toHaveBeenCalledTimes(1);
      expect(onActivateClimb).toHaveBeenCalledWith(CLIMB, undefined, { deliberate: true });
    });

    it('sits after the playlist controls, inside the glass region', () => {
      const actions = vi.fn(() => createElement('span', { 'data-owner-action': 'true' }));
      render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB], actions })} />);
      const order = Array.from(headerRightNode().querySelectorAll('[data-owner-action], [data-icon="play.fill"]')).map(
        (node) => (node.hasAttribute('data-owner-action') ? 'actions' : 'play'),
      );
      expect(order).toEqual(['actions', 'play']);
    });

    it('is absent on an empty list, behind the board banner and in edit mode', () => {
      const banner = { title: 't', subtitle: 's', cta: 'c', onPress: vi.fn() };
      const { rerender } = render(<PlaylistDetailView {...makeProps({ climbs: [] })} />);
      expect(lastHeaderOptions().headerRight).toBeUndefined();

      rerender(<PlaylistDetailView {...makeProps({ climbs: [CLIMB], boardBanner: banner })} />);
      expect(lastHeaderOptions().headerRight).toBeUndefined();

      rerender(<PlaylistDetailView {...makeProps({ climbs: [CLIMB], editMode: true })} />);
      expect(lastHeaderOptions().headerRight).toBeUndefined();
    });

    it('does not re-set the header when more rows land or the handler changes identity', () => {
      const props = makeProps({ climbs: [CLIMB] });
      const { rerender } = render(<PlaylistDetailView {...props} />);
      const callsAfterMount = ctrl.setOptions.mock.calls.length;
      const second = { ...CLIMB, uuid: 'second-row' };
      const onActivateClimb = vi.fn();

      rerender(<PlaylistDetailView {...props} climbs={[CLIMB, second]} onActivateClimb={onActivateClimb} />);
      expect(ctrl.setOptions.mock.calls.length).toBe(callsAfterMount);

      // The handler the header already holds calls the newest callback.
      fireEvent.click(headerRightNode().querySelector('[data-icon="play.fill"]') as HTMLElement);
      expect(onActivateClimb).toHaveBeenCalledWith(CLIMB, undefined, { deliberate: true });
    });
  });

  // ── Pull to refresh (HIG Refresh content controls) ─────────────────────────

  it('refreshes on a pull and spins until the refetch settles', async () => {
    let settle: () => void = () => undefined;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    const { container } = render(<PlaylistDetailView {...makeProps({ onRefresh })} />);
    const control = () => container.querySelector('[data-refresh-control]');

    fireEvent.click(control() as HTMLElement);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(control()?.getAttribute('data-refresh-control')).toBe('true');

    await act(async () => settle());
    expect(control()?.getAttribute('data-refresh-control')).toBe('false');
  });

  it('has no pull-to-refresh without an onRefresh', () => {
    const { container } = render(<PlaylistDetailView {...makeProps()} />);
    expect(container.querySelector('[data-refresh-control]')).toBeNull();
  });

  // ── Hero content ────────────────────────────────────────────────────────────

  it('renders the playlist name in the collapsed header bar', () => {
    const { getAllByText } = render(<PlaylistDetailView {...makeProps()} />);
    // The name appears both in the hero banner and the collapsed header bar
    const nodes = getAllByText('My Playlist');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the emoji icon when hero.icon is set', () => {
    const { getByText } = render(
      <PlaylistDetailView {...makeProps({ hero: { name: 'P', climbCount: 0, icon: '🏔️' } })} />,
    );
    expect(getByText('🏔️')).not.toBeNull();
  });

  it('falls back to the tag icon when hero.icon is absent', () => {
    const { container } = render(<PlaylistDetailView {...makeProps()} />);
    expect(container.querySelector('[data-icon="tag"]')).not.toBeNull();
  });

  it('renders description when provided', () => {
    const { getByText } = render(
      <PlaylistDetailView {...makeProps({ hero: { name: 'P', climbCount: 0, description: 'A great playlist' } })} />,
    );
    expect(getByText('A great playlist')).not.toBeNull();
  });

  it('renders subtitle when provided', () => {
    const { getByText } = render(
      <PlaylistDetailView {...makeProps({ hero: { name: 'P', climbCount: 0, subtitle: 'by Setter A' } })} />,
    );
    expect(getByText('by Setter A')).not.toBeNull();
  });

  it('reads the Material hero subtitle in secondaryLabel, not the low-contrast tertiary role', () => {
    ctrl.variant = 'material';
    const { getByText } = render(
      <PlaylistDetailView {...makeProps({ hero: { name: 'P', climbCount: 0, subtitle: 'by Setter A' } })} />,
    );
    expect(getByText('by Setter A').getAttribute('data-color')).toBe('#666666');
  });

  it('renders follower label when provided', () => {
    const { getByText } = render(
      <PlaylistDetailView {...makeProps({ hero: { name: 'P', climbCount: 0, followerLabel: '42 followers' } })} />,
    );
    expect(getByText('42 followers')).not.toBeNull();
  });

  // ── Loading / empty states ──────────────────────────────────────────────────

  it('shows skeleton rows when isLoading=true and climbs is empty', () => {
    const { container } = render(<PlaylistDetailView {...makeProps({ isLoading: true, climbs: [] })} />);
    expect(container.querySelectorAll('[data-skeleton-row]').length).toBeGreaterThan(0);
  });

  it('shows empty message and playlist icon when not loading and climbs is empty', () => {
    const { getByText, container } = render(<PlaylistDetailView {...makeProps({ isLoading: false, climbs: [] })} />);
    expect(getByText('No climbs yet')).not.toBeNull();
    expect(container.querySelector('[data-icon="playlist"]')).not.toBeNull();
  });

  it('renders the empty-state CTA in both variants and fires it on press', () => {
    const onPress = vi.fn();
    const emptyAction = { label: 'Add climbs', onPress };

    for (const variant of ['liquidGlass', 'material'] as const) {
      ctrl.variant = variant;
      const { getByText, unmount } = render(<PlaylistDetailView {...makeProps({ climbs: [], emptyAction })} />);
      fireEvent.click(getByText('Add climbs'));
      unmount();
    }

    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('leaves the empty state CTA-free when no emptyAction is given', () => {
    const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [] })} />);
    expect(container.querySelector('[data-button="true"]')).toBeNull();
  });

  it('shows a small footer spinner when isFetchingNextPage=true', () => {
    const { container } = render(<PlaylistDetailView {...makeProps({ isFetchingNextPage: true, climbs: [CLIMB] })} />);
    expect(container.querySelector('[data-spinner="small"]')).not.toBeNull();
  });

  it('shows no footer spinner when isFetchingNextPage=false', () => {
    const { container } = render(<PlaylistDetailView {...makeProps({ isFetchingNextPage: false, climbs: [CLIMB] })} />);
    expect(container.querySelector('[data-spinner="small"]')).toBeNull();
  });

  it('renders compatible rows against the active board', () => {
    render(
      <PlaylistDetailView
        {...makeProps({
          climbs: [KILTER_CLIMB],
          renderBoard: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 45 },
        })}
      />,
    );

    expect(capturedClimbRows[0]).toMatchObject({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      angle: 45,
      unsupported: false,
      showProgress: true,
    });
  });

  // The playlist being played marks the climb you're on, as the Climbs list does (#6671 QA).
  it('highlights the climb you last had up, the previewed one first', () => {
    const props = makeProps({ climbs: [KILTER_CLIMB, TENSION_CLIMB] });
    ctrl.activeClimbUuid = TENSION_CLIMB.uuid;
    const view = render(<PlaylistDetailView {...props} />);
    expect(capturedClimbRows.map(({ climb, selected }) => [climb.uuid, selected])).toEqual([
      [KILTER_CLIMB.uuid, false],
      [TENSION_CLIMB.uuid, true],
    ]);

    // A preview of another climb takes the highlight. (In the app the preview
    // context re-renders the rows; the mocked hook can't, so render again.)
    view.unmount();
    capturedClimbRows.length = 0;
    ctrl.previewedClimbUuid = KILTER_CLIMB.uuid;
    render(<PlaylistDetailView {...props} />);
    expect(capturedClimbRows.filter(({ selected }) => selected).map(({ climb }) => climb.uuid)).toEqual([
      KILTER_CLIMB.uuid,
    ]);
  });

  it('renders incompatible mixed-board rows on their own board and dims them', () => {
    render(
      <PlaylistDetailView
        {...makeProps({
          climbs: [KILTER_CLIMB, TENSION_CLIMB],
          renderBoard: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 45 },
        })}
      />,
    );

    expect(capturedClimbRows).toHaveLength(2);
    expect(capturedClimbRows[0]).toMatchObject({
      boardName: 'kilter',
      layoutId: 1,
      angle: 45,
      unsupported: false,
      showProgress: true,
    });
    expect(capturedClimbRows[1]).toMatchObject({
      boardName: 'tension',
      layoutId: 9,
      angle: 35,
      unsupported: true,
      showProgress: true,
    });
  });

  it('plays only the swiped climb next, without activating the playlist', () => {
    const onActivateClimb = vi.fn();
    render(<PlaylistDetailView {...makeProps({ climbs: [KILTER_CLIMB, TENSION_CLIMB], onActivateClimb })} />);

    const tensionRow = capturedClimbRows[1]!;
    expect(tensionRow.onPlayNext).toBeTypeOf('function');
    tensionRow.onPlayNext?.(tensionRow.climb);

    // The right swipe is Play next (#6772): the top of Up next, not the bottom.
    expect(ctrl.playNext).toHaveBeenCalledExactlyOnceWith({
      item: {
        uuid: 'queued-climb-uuid',
        suggested: undefined,
        climb: expect.objectContaining({ uuid: 'tension-row', boardType: 'tension', layoutId: 9, angle: 35 }),
      },
    });
    expect(onActivateClimb).not.toHaveBeenCalled();
  });

  it('opens Add to Playlist using each swiped row’s resolved board', () => {
    render(
      <PlaylistDetailView
        {...makeProps({
          climbs: [KILTER_CLIMB, TENSION_CLIMB],
          renderBoard: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 45 },
        })}
      />,
    );

    for (const row of capturedClimbRows) {
      expect(row.onOpenPlaylist).toBeTypeOf('function');
      row.onOpenPlaylist?.(row.climb);
      expect(ctrl.openAddToPlaylist).toHaveBeenLastCalledWith(
        row.climb,
        {
          boardName: row.boardName,
          layoutId: row.layoutId,
          sizeId: row.sizeId,
          setIds: row.setIds,
          angle: row.angle,
        },
        undefined,
      );
    }
    expect(ctrl.openAddToPlaylist).toHaveBeenCalledTimes(2);
    expect(ctrl.playNext).not.toHaveBeenCalled();
  });

  it('keeps edit mode on reorder/remove rows without swipe actions', () => {
    render(<PlaylistDetailView {...makeProps({ climbs: [KILTER_CLIMB], editMode: true })} />);

    expect(capturedClimbRows).toHaveLength(0);
    expect(capturedEditRows).toHaveLength(1);
    expect(ctrl.playNext).not.toHaveBeenCalled();
    expect(ctrl.openAddToPlaylist).not.toHaveBeenCalled();
  });

  it.each([1, 1.5])('gives supported and unavailable edit rows one drag height at font scale %s', (fontScale) => {
    ctrl.fontScale = fontScale;
    applyClimbRowPreset('namesOnly');
    const { container } = render(
      <PlaylistDetailView
        {...makeProps({ climbs: [KILTER_CLIMB, UNKNOWN_BOARD_CLIMB, TENSION_CLIMB], editMode: true })}
      />,
    );
    const expectedHeight = fontScale === 1 ? 76 : 105;
    expect(capturedEditRows.map((row) => row.minimumHeight)).toEqual([expectedHeight, expectedHeight]);
    expect(container.querySelector(`[data-min-height="${expectedHeight}"]`)).not.toBeNull();
  });

  it('shows an indicator for climbs whose render board cannot be resolved', () => {
    const onActivateClimb = vi.fn();
    const { getByText } = render(
      <PlaylistDetailView
        {...makeProps({
          climbs: [UNKNOWN_BOARD_CLIMB],
          onActivateClimb,
        })}
      />,
    );

    expect(getByText('Unknown Board Row')).not.toBeNull();
    expect(getByText('detail.unrenderableClimb.subtitle')).not.toBeNull();
    expect(capturedClimbRows).toHaveLength(0);
    expect(onActivateClimb).not.toHaveBeenCalled();
  });

  // The row for a climb that cannot be drawn stands among climb rows, so it
  // copies their shape: a thumbnail-sized frame and a separator past it, or with
  // thumbnails switched off neither.
  it('gives an unresolved climb a thumbnail-sized frame, with its separator past it', () => {
    const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [UNKNOWN_BOARD_CLIMB] })} />);

    expect(container.querySelector('[data-icon="warning"]')).not.toBeNull();
    expect(container.querySelector('[data-width="76"]')).not.toBeNull();
    // Gutter, thumbnail, gap.
    expect(container.querySelector('[data-margin-start="104"]')).not.toBeNull();
  });

  it('drops that frame with thumbnails switched off, and starts the separator at the gutter', () => {
    setClimbRowField('thumbnail', false);

    const { container, getByText } = render(<PlaylistDetailView {...makeProps({ climbs: [UNKNOWN_BOARD_CLIMB] })} />);

    // Still says which climb it is and why it is not drawn.
    expect(getByText('Unknown Board Row')).not.toBeNull();
    expect(getByText('detail.unrenderableClimb.subtitle')).not.toBeNull();
    expect(container.querySelector('[data-icon="warning"]')).toBeNull();
    expect(container.querySelector('[data-width="76"]')).toBeNull();
    expect(container.querySelector('[data-margin-start="104"]')).toBeNull();
    expect(container.querySelector('[data-margin-start="16"]')).not.toBeNull();
  });

  it('follows the switch on an unresolved row that is already on screen', () => {
    const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [UNKNOWN_BOARD_CLIMB] })} />);

    act(() => setClimbRowField('thumbnail', false));

    expect(container.querySelector('[data-width="76"]')).toBeNull();
    expect(container.querySelector('[data-margin-start="16"]')).not.toBeNull();
  });

  it('lets owners remove unresolved climbs in edit mode', () => {
    const onRemoveClimb = vi.fn();
    const { getByLabelText } = render(
      <PlaylistDetailView
        {...makeProps({
          climbs: [UNKNOWN_BOARD_CLIMB],
          editMode: true,
          onRemoveClimb,
        })}
      />,
    );

    fireEvent.click(getByLabelText('editClimbs.removeAria:Unknown Board Row'));

    expect(onRemoveClimb).toHaveBeenCalledWith('unknown-board-row');
  });

  it('keeps edit row board props stable across parent rerenders', () => {
    const climbs = [KILTER_CLIMB];
    const renderBoard = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 45 };
    const { rerender } = render(<PlaylistDetailView {...makeProps({ climbs, renderBoard, editMode: true })} />);

    rerender(<PlaylistDetailView {...makeProps({ climbs, renderBoard, editMode: true })} />);

    expect(capturedEditRows).toHaveLength(2);
    expect(capturedEditRows[1]?.board).toBe(capturedEditRows[0]?.board);
  });

  // ── Board backdrop ──────────────────────────────────────────────────────────

  it('renders PlaylistBoardBackdrop when showBoardBackdrop and boardType are set', () => {
    const { container } = render(
      <PlaylistDetailView
        {...makeProps({ hero: { name: 'P', climbCount: 0, showBoardBackdrop: true, boardType: 'kilter' } })}
      />,
    );
    expect(container.querySelector('[data-backdrop="kilter"]')).not.toBeNull();
  });

  it('does not render backdrop when showBoardBackdrop is false', () => {
    const { container } = render(
      <PlaylistDetailView
        {...makeProps({ hero: { name: 'P', climbCount: 0, showBoardBackdrop: false, boardType: 'kilter' } })}
      />,
    );
    expect(container.querySelector('[data-backdrop]')).toBeNull();
  });

  it('uses translucent gradient colors when board backdrop is enabled', () => {
    const { container } = render(
      <PlaylistDetailView
        {...makeProps({
          hero: { name: 'P', climbCount: 0, showBoardBackdrop: true, boardType: 'kilter', color: '#8C4A52' },
        })}
      />,
    );
    const gradients = container.querySelectorAll('[data-gradient]');
    // The first gradient is the colour wash — its colors should be the withAlpha strings
    const firstGradientColors: string[] = JSON.parse(gradients[0]?.getAttribute('data-gradient') ?? '[]');
    expect(firstGradientColors.every((c) => c.includes('|0.82'))).toBe(true);
  });

  it('uses opaque gradient colors when board backdrop is disabled', () => {
    const { container } = render(
      <PlaylistDetailView
        {...makeProps({ hero: { name: 'P', climbCount: 0, showBoardBackdrop: false, color: '#8C4A52' } })}
      />,
    );
    const gradients = container.querySelectorAll('[data-gradient]');
    const firstGradientColors: string[] = JSON.parse(gradients[0]?.getAttribute('data-gradient') ?? '[]');
    // No alpha suffix means opaque colors from buildHeroGradient
    expect(firstGradientColors.every((c) => !c.includes('|0.82'))).toBe(true);
  });

  // ── Material 3 branch ─────────────────────────────────────────────────────────
  describe('material variant', () => {
    beforeEach(() => {
      ctrl.variant = 'material';
    });

    it('renders the Paper app bar instead of the gradient hero', () => {
      const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB] })} />);
      expect(container.querySelector('[data-appbar]')).not.toBeNull();
      // No gradient hero in the Material branch.
      expect(container.querySelector('[data-gradient]')).toBeNull();
    });

    it('pins the app bar wrapper to the top, not the Appbar.Header style (#6568)', () => {
      const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB] })} />);
      const appbar = container.querySelector('[data-appbar]') as HTMLElement;
      expect(appbar.getAttribute('data-appbar-style-position')).toBeNull();
      expect(appbar.getAttribute('data-status-bar-height')).toBe('0');
      const wrapper = appbar.parentElement as HTMLElement;
      expect(wrapper.getAttribute('data-position')).toBe('absolute');
      expect(wrapper.getAttribute('data-top')).toBe('0');
    });

    it("sizes the app bar to the scroll-math bar height, not Paper's 64px default", () => {
      const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB] })} />);
      const appbar = container.querySelector('[data-appbar]') as HTMLElement;
      expect(appbar.getAttribute('data-appbar-height')).toBe('56');
    });

    it('keeps its in-body app bar and hides the native header (header XOR in-body Appbar)', () => {
      render(<PlaylistDetailView {...makeProps()} />);
      expect(lastHeaderOptions()).toMatchObject({ headerShown: false });
    });

    it('back action calls router.back', () => {
      const { container } = render(<PlaylistDetailView {...makeProps()} />);
      fireEvent.click(container.querySelector('[data-icon="back"]') as HTMLElement);
      expect(ctrl.back).toHaveBeenCalledTimes(1);
    });

    it('renders the activate-all play action and wires it to the first climb', () => {
      const onActivateClimb = vi.fn();
      const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB], onActivateClimb })} />);
      const playAction = container.querySelector('[data-appbar-action="play"]');
      expect(playAction).not.toBeNull();
      fireEvent.click(playAction as HTMLElement);
      // A deliberate start: Light the board when I tap a climb (a row-tap
      // setting) must not turn the Play button into a preview (#6667).
      expect(onActivateClimb).toHaveBeenCalledWith(CLIMB, undefined, { deliberate: true });
      expect(playAction?.getAttribute('aria-label')).toBe('detail.activateAll');
    });

    it('omits the activate-all action when the list is empty', () => {
      const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [] })} />);
      expect(container.querySelector('[data-appbar-action="play"]')).toBeNull();
    });

    it('renders the richer empty state when emptyState is provided', () => {
      const { getByText } = render(
        <PlaylistDetailView
          {...makeProps({
            climbs: [],
            isLoading: false,
            emptyState: { icon: 'favorite', title: 'No likes yet', supporting: 'Tap the heart' },
          })}
        />,
      );
      expect(getByText('No likes yet')).not.toBeNull();
      expect(getByText('Tap the heart')).not.toBeNull();
    });

    it('falls back to emptyMessage when no emptyState is given', () => {
      const { getByText } = render(
        <PlaylistDetailView {...makeProps({ climbs: [], isLoading: false, emptyMessage: 'Nothing here' })} />,
      );
      expect(getByText('Nothing here')).not.toBeNull();
    });

    it('shows skeleton rows while loading', () => {
      const { container } = render(<PlaylistDetailView {...makeProps({ isLoading: true, climbs: [] })} />);
      expect(container.querySelectorAll('[data-skeleton-row]').length).toBeGreaterThan(0);
    });

    it('surfaces the actions node in the app bar (compact form)', () => {
      // The owner's Follow / Pin / More controls must reach the Material app bar —
      // dropping them leaves a playlist owner with no edit/pin/delete on Material.
      const actions = vi.fn((collapsed: boolean) =>
        createElement('span', { 'data-action-collapsed': String(collapsed) }, 'action'),
      );
      const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB], actions })} />);
      // App bar is always present on Material, so actions are asked for the compact
      // (collapsed) icon form rather than the scroll-driven pill.
      expect(actions).toHaveBeenCalledWith(true);
      expect(container.querySelector('[data-action-collapsed="true"]')).not.toBeNull();
    });
  });

  // ── Board-mismatch banner ──────────────────────────────────────────────────
  describe('board mismatch banner', () => {
    const banner = {
      title: 'Switch to Kilter to climb this playlist',
      subtitle: 'These are Kilter climbs. Switch boards to queue them.',
      cta: 'Switch board',
      onPress: vi.fn(),
    };

    beforeEach(() => {
      banner.onPress.mockClear();
    });

    it('renders the banner title, subtitle and CTA when boardBanner is set', () => {
      const { getByText } = render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB], boardBanner: banner })} />);
      expect(getByText(banner.title)).not.toBeNull();
      expect(getByText(banner.subtitle)).not.toBeNull();
      expect(getByText(banner.cta)).not.toBeNull();
    });

    it('clicking the banner CTA calls boardBanner.onPress', () => {
      const { getByText } = render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB], boardBanner: banner })} />);
      fireEvent.click(getByText(banner.cta));
      expect(banner.onPress).toHaveBeenCalledTimes(1);
    });

    it('renders no banner when boardBanner is absent', () => {
      const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB] })} />);
      expect(container.querySelector('[data-button]')).toBeNull();
    });

    it('hides the Material activate-all action while the banner is shown', () => {
      ctrl.variant = 'material';
      const { container } = render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB], boardBanner: banner })} />);
      // Playlist-level activate-all is blocked on a board mismatch, so the play
      // action is gone even though the list has climbs.
      expect(container.querySelector('[data-appbar-action="play"]')).toBeNull();
    });

    it('still activates a row while the banner is shown', () => {
      const onActivateClimb = vi.fn();
      const { container } = render(
        <PlaylistDetailView
          {...makeProps({
            climbs: [TENSION_CLIMB],
            boardBanner: banner,
            onActivateClimb,
          })}
        />,
      );

      fireEvent.click(container.querySelector('[data-climb-row="tension-row"]') as HTMLElement);

      expect(onActivateClimb).toHaveBeenCalledWith(TENSION_CLIMB);
      expect(banner.onPress).not.toHaveBeenCalled();
    });
  });
  describe('add-to-queue row', () => {
    const CLIMBS = [CLIMB];

    function renderRow(overrides: Partial<PlaylistDetailViewProps> = {}) {
      return render(<PlaylistDetailView {...makeProps({ climbs: CLIMBS, onQueueAll: vi.fn(), ...overrides })} />);
    }

    it('renders in the list header on the glass variant', () => {
      const { container } = renderRow();
      expect(container.querySelector('[data-add-to-queue-row]')).not.toBeNull();
    });

    it('renders in the list header on the material variant', () => {
      // The destructive bulk control is Material-only (an Appbar.Action), so the
      // additive one has to exist on BOTH branches or iOS gets nothing.
      ctrl.variant = 'material';
      const { container } = renderRow();
      expect(container.querySelector('[data-add-to-queue-row]')).not.toBeNull();
    });

    it('sits above the discussion row — a queue action outranks a comment thread', () => {
      const { container } = renderRow({
        headerSlot: <div data-discussion-slot="true" />,
      });
      const nodes = Array.from(container.querySelectorAll('[data-add-to-queue-row], [data-discussion-slot]'));
      expect(nodes.map((node) => node.getAttribute('data-add-to-queue-row') ?? 'discussion')).toEqual([
        'true',
        'discussion',
      ]);
    });

    it('forwards the placement and which one is in flight', () => {
      const onQueueAll = vi.fn();
      const { container } = renderRow({ onQueueAll, pendingQueueAll: 'end' });
      const row = container.querySelector('[data-add-to-queue-row]') as HTMLButtonElement;
      expect(row.getAttribute('data-pending')).toBe('end');
      fireEvent.click(row);
      expect(onQueueAll).toHaveBeenCalledExactlyOnceWith('next');
    });

    it('passes no placement in flight by default', () => {
      const { container } = renderRow();
      expect(container.querySelector('[data-add-to-queue-row]')?.getAttribute('data-pending')).toBe('null');
    });

    it('is absent when the host withholds the handler (no active board)', () => {
      const { container } = render(<PlaylistDetailView {...makeProps({ climbs: CLIMBS })} />);
      expect(container.querySelector('[data-add-to-queue-row]')).toBeNull();
    });

    it('is absent on an empty playlist', () => {
      const { container } = renderRow({ climbs: [] });
      expect(container.querySelector('[data-add-to-queue-row]')).toBeNull();
    });

    it('is absent while the switch-board banner is shown', () => {
      // The playlist is on another board, so the board-scoped fetch would return
      // nothing; the banner owns that prompt.
      const { container } = renderRow({
        boardBanner: { title: 't', subtitle: 's', cta: 'c', onPress: vi.fn() },
      });
      expect(container.querySelector('[data-add-to-queue-row]')).toBeNull();
    });

    it('is absent in edit mode', () => {
      const { container } = renderRow({ editMode: true });
      expect(container.querySelector('[data-add-to-queue-row]')).toBeNull();
    });
  });

  // ── Sort and filters (#6651) ─────────────────────────────────────────────────

  describe('filter chrome', () => {
    const FILTER_BAR = <div data-filter-bar="true" />;
    const filterAction = { activeCount: 2, onPress: vi.fn() };

    function headerRightNode(): HTMLElement {
      const headerRight = lastHeaderOptions().headerRight as (() => ReactNode) | undefined;
      if (!headerRight) throw new Error('no headerRight');
      return render(createElement('div', null, headerRight())).container;
    }

    function scrollTo(stage: 0 | 1 | 2) {
      act(() => ctrl.scrollStageReaction?.(stage, null));
    }

    it('puts the filter bar under the hero, above the banner, Play next / Play last and discussion', () => {
      const { container } = render(
        <PlaylistDetailView
          {...makeProps({
            climbs: [CLIMB],
            onQueueAll: vi.fn(),
            filterBar: FILTER_BAR,
            headerSlot: <div data-discussion-slot="true" />,
          })}
        />,
      );
      const nodes = Array.from(
        container.querySelectorAll('[data-filter-bar], [data-add-to-queue-row], [data-discussion-slot]'),
      );
      expect(
        nodes.map((node) =>
          node.hasAttribute('data-filter-bar')
            ? 'filters'
            : node.hasAttribute('data-add-to-queue-row')
              ? 'queue'
              : 'discussion',
        ),
      ).toEqual(['filters', 'queue', 'discussion']);
    });

    it('keeps the filter bar outside the hero banner it measures, in its own measured view', () => {
      const { container } = render(<PlaylistDetailView {...makeProps({ filterBar: FILTER_BAR })} />);
      const measured = Array.from(container.querySelectorAll('[data-has-layout="true"]'));
      const heroBanner = measured.find((node) => node.textContent?.includes('My Playlist'));
      expect(heroBanner?.querySelector('[data-filter-bar]')).toBeNull();
      expect(container.querySelector('[data-filter-bar]')?.parentElement?.getAttribute('data-has-layout')).toBe('true');
    });

    it('shows ≡ in the glass header only once the filter bar has scrolled away, not the hero alone', () => {
      // A smart list: no other actions, so until ≡ shows there is no header item
      // at all. iOS draws an empty glass capsule for one that renders nothing.
      render(<PlaylistDetailView {...makeProps({ filterAction })} />);
      expect(lastHeaderOptions().headerRight).toBeUndefined();

      scrollTo(1);
      expect(lastHeaderOptions().headerRight).toBeUndefined();

      scrollTo(2);
      const button = headerRightNode().querySelector('[data-icon="filter"]') as HTMLElement;
      expect(button).not.toBeNull();
      expect(button.getAttribute('aria-label')).toBe('mobile.search.filterCountAria');
      fireEvent.click(button);
      expect(filterAction.onPress).toHaveBeenCalled();
    });

    it('puts ≡ before the other header actions and clears any native bar item', () => {
      const actions = vi.fn(() => createElement('span', { 'data-owner-action': 'true' }));
      render(<PlaylistDetailView {...makeProps({ filterAction, actions })} />);
      scrollTo(2);
      const header = headerRightNode();
      const order = Array.from(header.querySelectorAll('[data-icon="filter"], [data-owner-action]')).map((node) =>
        node.hasAttribute('data-owner-action') ? 'actions' : 'filter',
      );
      expect(order).toEqual(['filter', 'actions']);
      expect(lastHeaderOptions()).toHaveProperty('unstable_headerRightItems', undefined);
    });

    it('never shows ≡ in edit mode', () => {
      render(<PlaylistDetailView {...makeProps({ filterAction, editMode: true })} />);
      scrollTo(2);
      expect(lastHeaderOptions().headerRight).toBeUndefined();
    });

    it('sets no header item while the actions render nothing and ≡ is not up', () => {
      // A signed-out viewer of someone's playlist: no Follow, no pin.
      const actions = vi.fn(() => null);
      render(<PlaylistDetailView {...makeProps({ filterAction, actions })} />);
      expect(lastHeaderOptions().headerRight).toBeUndefined();
      expect(lastHeaderOptions()).toHaveProperty('unstable_headerRightItems', undefined);

      scrollTo(2);
      const header = headerRightNode();
      expect(header.querySelector('[data-icon="filter"]')).not.toBeNull();
    });

    it('keeps the header item while the actions render something, ≡ or not', () => {
      const actions = vi.fn(() => createElement('span', { 'data-owner-action': 'true' }));
      render(<PlaylistDetailView {...makeProps({ filterAction, actions })} />);
      const header = headerRightNode();
      expect(header.querySelector('[data-owner-action]')).not.toBeNull();
      expect(header.querySelector('[data-icon="filter"]')).toBeNull();
    });

    it('keeps ≡ in the Material app bar outside edit mode', () => {
      ctrl.variant = 'material';
      const { container, rerender } = render(<PlaylistDetailView {...makeProps({ filterAction })} />);
      expect(container.querySelector('[data-appbar="true"] [data-icon="filter"]')).not.toBeNull();

      rerender(<PlaylistDetailView {...makeProps({ filterAction, editMode: true })} />);
      expect(container.querySelector('[data-appbar="true"] [data-icon="filter"]')).toBeNull();
    });

    it('does not re-set the header on a re-render with the same filter action', () => {
      const props = makeProps({ filterAction, filterBar: FILTER_BAR });
      const { rerender } = render(<PlaylistDetailView {...props} />);
      const callsAfterMount = ctrl.setOptions.mock.calls.length;
      rerender(<PlaylistDetailView {...props} />);
      expect(ctrl.setOptions.mock.calls.length).toBe(callsAfterMount);
    });

    it('keeps the scroll offset when new rows replace the list, rather than chasing a moved row', () => {
      render(<PlaylistDetailView {...makeProps({ climbs: [CLIMB] })} />);
      expect(ctrl.maintainVisibleContentPosition).toEqual({ disabled: true });
    });

    it('uses the given empty-state icon in the glass look', () => {
      const { container } = render(<PlaylistDetailView {...makeProps({ emptyIcon: 'filter' })} />);
      expect(container.querySelector('[data-icon="filter"]')).not.toBeNull();
      expect(container.querySelector('[data-icon="playlist"]')).toBeNull();
    });

    it('labels Play next / Play last with the filtered count', () => {
      const { container } = render(
        <PlaylistDetailView {...makeProps({ climbs: [CLIMB], onQueueAll: vi.fn(), addToQueueCount: 12 })} />,
      );
      expect(container.querySelector('[data-add-to-queue-row]')?.getAttribute('data-count')).toBe('12');
    });
  });
});
