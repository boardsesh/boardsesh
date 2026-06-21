// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';

const ctrl = vi.hoisted(() => ({ back: vi.fn(), variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

type CapturedClimbListRowProps = {
  climb: { uuid: string; name: string };
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  unsupported?: boolean;
  onPress?: (climb: { uuid: string; name: string }) => void;
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

vi.mock('expo-router', () => ({ useRouter: () => ({ back: ctrl.back }) }));

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
vi.mock('../../../providers/theme-provider', () => ({
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

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardConfig: null }),
}));

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
  iosSystemColors: { white: '#ffffff', systemGray4: '#aeaeb2' },
}));

// ── Leaf components ───────────────────────────────────────────────────────────
vi.mock('../../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant ?? '' }, children),
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
    ctrl.variant = 'liquidGlass';
    capturedClimbRows.length = 0;
    capturedEditRows.length = 0;
  });

  // ── Navigation ──────────────────────────────────────────────────────────────

  it('always renders the back FAB', () => {
    const { container } = render(<PlaylistDetailView {...makeProps()} />);
    const btn = container.querySelector('[data-icon="back"]');
    expect(btn).not.toBeNull();
  });

  it('clicking the back FAB calls router.back', () => {
    const { container } = render(<PlaylistDetailView {...makeProps()} />);
    fireEvent.click(container.querySelector('[data-icon="back"]') as HTMLElement);
    expect(ctrl.back).toHaveBeenCalledTimes(1);
  });

  // ── Action threading ────────────────────────────────────────────────────────

  it('calls actions(false) initially and renders the returned node', () => {
    const actions = vi.fn((collapsed: boolean) =>
      createElement('span', { 'data-action-collapsed': String(collapsed) }, 'action'),
    );
    const { container } = render(<PlaylistDetailView {...makeProps({ actions })} />);
    expect(actions).toHaveBeenCalledWith(false);
    expect(container.querySelector('[data-action-collapsed="false"]')).not.toBeNull();
  });

  it('renders no actions container when actions prop is omitted', () => {
    const { container } = render(<PlaylistDetailView {...makeProps()} />);
    // Only the back FAB button should be present; no extra data-icon= elements
    const allButtons = container.querySelectorAll('button[data-icon]');
    expect(allButtons).toHaveLength(1);
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
    });
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
    });
    expect(capturedClimbRows[1]).toMatchObject({
      boardName: 'tension',
      layoutId: 9,
      angle: 35,
      unsupported: true,
    });
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
      expect(onActivateClimb).toHaveBeenCalledWith(CLIMB);
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
});
