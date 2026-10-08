// @vitest-environment jsdom
vi.mock('../../../../src/components/AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../../src/hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../../../src/components/PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { Climb as SchemaClimb } from '@boardsesh/shared-schema';

const ctrl = vi.hoisted(() => ({
  back: vi.fn(),
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  addToQueue: vi.fn(),
  openAddToPlaylist: vi.fn(),
  openClimbActions: vi.fn(),
  append: vi.fn(),
  activate: vi.fn(),
  busy: false,
  shared: false,
  boardMissing: false,
  empty: false,
}));

type CapturedClimbListRowProps = {
  climb: SchemaClimb;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  unsupported?: boolean;
  onPress?: (climb: { uuid: string; name: string }) => void;
  onAddToQueue?: (climb: SchemaClimb) => void;
  onOpenPlaylist?: (climb: SchemaClimb) => void;
};

type CapturedPlaylistEditClimbRowProps = {
  climb: Climb;
  board: {
    boardName: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
    angle: number;
  };
};

const capturedClimbRows = vi.hoisted(() => [] as CapturedClimbListRowProps[]);
const capturedEditRows = vi.hoisted(() => [] as CapturedPlaylistEditClimbRowProps[]);

// ── React Native ──────────────────────────────────────────────────────────────
vi.mock('react-native', () => ({
  RefreshControl: () => null,
  View: ({
    children,
    pointerEvents,
    onLayout,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    pointerEvents?: string;
    onLayout?: (e: unknown) => void;
    accessibilityLabel?: string;
  }) => {
    const attrs: Record<string, unknown> = {};
    if (pointerEvents) attrs['data-pointer-events'] = pointerEvents;
    if (onLayout) attrs['data-has-layout'] = 'true';
    if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
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
  useAnimatedReaction: () => undefined,
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
  }: {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    onEndReached?: () => void;
  }) => {
    const rowNodes = data?.map((item, index) => {
      const key =
        typeof item === 'object' && item !== null && 'uuid' in item ? String((item as { uuid?: unknown }).uuid) : index;
      return renderItem ? createElement('div', { key }, renderItem({ item, index })) : null;
    });
    return createElement(
      'div',
      { 'data-list': 'true', onClick: onEndReached },
      ListHeaderComponent ?? null,
      data?.length === 0 ? (ListEmptyComponent ?? null) : null,
      rowNodes ?? null,
      ListFooterComponent ?? null,
    );
  },
}));

const navigation = vi.hoisted(() => ({ setOptions: vi.fn() }));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ username: 'tester' }),
  useRouter: () => ({ back: ctrl.back, push: vi.fn() }),
  useNavigation: () => navigation,
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
vi.mock('../../../../src/providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: {
      label: '#000000',
      secondaryLabel: '#666666',
      tertiaryLabel: '#999999',
      fill: '#eeeeee',
      background: '#ffffff',
      secondaryBackground: '#f2f2f2',
      tertiaryBackground: '#e5e5e5',
    },
    brandColors: { primary: '#6D28D9' },
    opacity: { disabled: 0.5 },
  }),
}));

vi.mock('../../../../src/providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({
    boardConfig: null,
    openClimbActions: ctrl.openClimbActions,
    openAddToPlaylist: ctrl.openAddToPlaylist,
  }),
}));
vi.mock('../../../../src/providers/queue-provider', () => ({
  useQueueActions: () => ({ addToQueue: ctrl.addToQueue }),
  useIsSharedSession: () => ctrl.shared,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queued-climb-uuid' }));

vi.mock('../../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
// The collapsed-bar ProgressiveBlur reads the surface mode; 'blur' renders its iOS
// blur path and short-circuits the native a11y / glass-capability hooks.
vi.mock('../../../../src/hooks/use-effective-surface-mode', () => ({ useEffectiveSurfaceMode: () => 'blur' }));

vi.mock('../../../../src/theme/layout', () => ({ glassSize: { standard: 48, capsule: 36, hero: 56 } }));
vi.mock('../../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 12: 48 },
  borderRadius: { lg: 12, xl: 24 },
}));
vi.mock('../../../../src/theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `${color}|${alpha}`,
}));
vi.mock('../../../../src/theme/ios-colors', () => ({
  iosSystemColors: { white: '#ffffff', systemGray4: '#aeaeb2' },
}));

// ── Leaf components ───────────────────────────────────────────────────────────
vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant ?? '' }, children),
}));

vi.mock('../../../../src/components/Icon', () => ({
  Icon: ({ name, size }: { name: string; size?: number }) =>
    createElement('span', { 'data-icon': name, 'data-size': size }),
}));

vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: ({ size }: { size?: string }) => createElement('div', { 'data-spinner': size ?? 'default' }),
}));

vi.mock('../../../../src/components/ClimbListRow', () => ({
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
vi.mock('../../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { 'data-button': 'true', onClick: onPress }, title),
}));

vi.mock('../../../../src/components/ClimbListRowSkeleton', () => ({
  ClimbListRowSkeleton: () => createElement('div', { 'data-skeleton-row': 'true' }),
}));

// icon-map is pure data but pulls in expo-symbols types via Icon's import chain;
// stub it so the component's `type IconName` import resolves without RN deps.
vi.mock('../../../../src/components/icon-map', () => ({ iconMap: {} }));

// react-native-paper drags in expo-modules-core at import time; stub the only
// pieces the Material branch uses so the suite can load.
vi.mock('react-native-paper', () => {
  const Header = ({ children }: { children?: ReactNode }) => createElement('div', { 'data-appbar': 'true' }, children);
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

vi.mock('../../../../src/components/GlassIconButton', () => ({
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
vi.mock('../../../../src/components/GlassSurface', () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-glass-surface': 'true' }, children ?? null),
}));
vi.mock('../../../../src/components/ProgressiveBlur', () => ({
  ProgressiveBlur: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('../../../../src/components/playlist/PlaylistAddToQueueRow', () => ({
  PlaylistAddToQueueRow: ({ onPress, isAppending }: { onPress: () => void; isAppending: boolean }) =>
    createElement('button', {
      'data-add-to-queue-row': 'true',
      'data-appending': String(isAppending),
      onClick: onPress,
    }),
}));

vi.mock('../../../../src/components/playlist/PlaylistBoardBackdrop', () => ({
  PlaylistBoardBackdrop: ({ boardType }: { boardType: string }) => createElement('div', { 'data-backdrop': boardType }),
}));

// Edit-mode helpers pull in react-native-gesture-handler / reanimated worklets
// that don't parse under jsdom; the view defaults editMode off, so stub them.
vi.mock('../../../../src/components/playlist/use-playlist-drag', () => ({
  usePlaylistDrag: () => ({
    isDragging: false,
    controls: { shared: {}, onRowHeight: () => {}, makeHandleGesture: () => ({}) },
  }),
}));
vi.mock('../../../../src/components/playlist/PlaylistEditClimbRow', () => ({
  PlaylistEditClimbRow: (props: CapturedPlaylistEditClimbRowProps) => {
    capturedEditRows.push(props);
    return createElement('div', { 'data-edit-climb-row': props.climb.uuid });
  },
}));

// Use real playlist-gradient and playlist-colors (pure TS, no RN imports).

// ── Subject ───────────────────────────────────────────────────────────────────
import {
  PlaylistDetailView,
  type PlaylistDetailViewProps,
} from '../../../../src/components/playlist/PlaylistDetailView';

// ── Helpers ───────────────────────────────────────────────────────────────────
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

vi.mock('../../../../src/components/playlist', async () => ({
  PlaylistDetailView: (
    await vi.importActual<typeof import('../../../../src/components/playlist/PlaylistDetailView')>(
      '../../../../src/components/playlist/PlaylistDetailView',
    )
  ).PlaylistDetailView,
  PlaylistStateHeader: () => null,
}));
vi.mock('../../../../src/components/SetterFollowButton', () => ({
  SetterFollowButton: () => createElement('span', null, 'Follow'),
}));
vi.mock('../../../../src/lib/playlists/use-playlist-render-board', () => ({
  usePlaylistRenderBoard: () => ({
    renderBoard: ctrl.boardMissing ? null : { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
  }),
}));
vi.mock('../../../../src/lib/playlists/use-playlist-activation', () => ({
  usePlaylistActivation: () => ({
    activate: ctrl.activate,
    addToQueue: { append: ctrl.append, isAppending: ctrl.busy },
  }),
}));
vi.mock('../../../../src/lib/graphql/hooks/use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: () => ({
    data: { pages: [{ climbs: ctrl.empty ? [] : [CLIMB] }] },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({ useSearchClimbsCount: () => ({ data: ctrl.empty ? 0 : 1 }) }));
vi.mock('../../../../src/lib/graphql/offline-request', () => ({ offlineAwareRequest: vi.fn() }));
import SetterPlaylist from '../setter/[username]';
import { cleanup } from '@testing-library/react';
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  ctrl.variant = 'liquidGlass';
  ctrl.busy = false;
  ctrl.shared = false;
  ctrl.boardMissing = false;
  ctrl.empty = false;
});
describe('setter route with the real PlaylistDetailView', () => {
  it.each(['liquidGlass', 'material'] as const)('shows the append row on the %s route', (variant) => {
    ctrl.variant = variant;
    ctrl.busy = true;
    const screen = render(createElement(SetterPlaylist));
    expect(screen.container.querySelector('[data-climb-row]')).not.toBeNull();
    const row = screen.container.querySelector('[data-add-to-queue-row]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-appending')).toBe('true');
    fireEvent.click(row!);
    expect(ctrl.append).toHaveBeenCalledOnce();
    expect(ctrl.activate).not.toHaveBeenCalled();
  });
  it.each(['liquidGlass', 'material'] as const)(
    'real %s detail control forwards append and busy without activating',
    (variant) => {
      ctrl.variant = variant;
      const screen = render(
        createElement(
          PlaylistDetailView,
          makeProps({ climbs: [CLIMB], onAddAllToQueue: ctrl.append, isAddingAllToQueue: true }),
        ),
      );
      const row = screen.container.querySelector('[data-add-to-queue-row]');
      expect(row).not.toBeNull();
      expect(row?.getAttribute('data-appending')).toBe('true');
      fireEvent.click(row!);
      expect(ctrl.append).toHaveBeenCalledOnce();
      expect(ctrl.activate).not.toHaveBeenCalled();
    },
  );
  it('keeps board selection without append when no board is available', () => {
    ctrl.boardMissing = true;
    const screen = render(createElement(SetterPlaylist));
    expect(screen.container.querySelector('[data-add-to-queue-row]')).toBeNull();
    expect(screen.getByRole('button', { name: 'authors.chooseBoard' })).not.toBeNull();
  });
  it('hides append for an empty setter list', () => {
    ctrl.empty = true;
    const screen = render(createElement(SetterPlaylist));
    expect(screen.container.querySelector('[data-add-to-queue-row]')).toBeNull();
  });
});
