// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';

import type { UiVariant } from '../../../theme/resolve-ui-variant';

const ctrl = vi.hoisted(() => ({ back: vi.fn(), variant: 'liquidGlass' as UiVariant }));

// ── React Native ──────────────────────────────────────────────────────────────
vi.mock('react-native', () => ({
  View: ({
    children,
    pointerEvents,
    style,
    onLayout,
  }: {
    children?: ReactNode;
    pointerEvents?: string;
    style?: unknown;
    onLayout?: (e: unknown) => void;
  }) => {
    const attrs: Record<string, unknown> = {};
    if (pointerEvents) attrs['data-pointer-events'] = pointerEvents;
    if (onLayout) attrs['data-has-layout'] = 'true';
    return createElement('div', attrs, children);
  },
  StyleSheet: {
    create: (s: Record<string, unknown>) => s,
    absoluteFill: {},
    hairlineWidth: 1,
  },
}));

// ── Reanimated ────────────────────────────────────────────────────────────────
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
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
    ListHeaderComponent,
    ListEmptyComponent,
    ListFooterComponent,
    onEndReached,
  }: {
    data?: unknown[];
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    onEndReached?: () => void;
  }) =>
    createElement(
      'div',
      { 'data-list': 'true', onClick: onEndReached },
      ListHeaderComponent ?? null,
      data?.length === 0 ? (ListEmptyComponent ?? null) : null,
      ListFooterComponent ?? null,
    ),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ back: ctrl.back }) }));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => key }),
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
      elevatedSurface: '#ffffff',
    },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardConfig: null }),
}));

vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));

vi.mock('../../../theme/layout', () => ({ glassSize: { standard: 48, capsule: 36, hero: 56 } }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 4: 16, 5: 20, 12: 48 },
  borderRadius: { xl: 24 },
}));
vi.mock('../../../theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `${color}|${alpha}`,
}));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#ffffff', systemGray4: '#aeaeb2', systemRed: '#ff3b30' },
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

vi.mock('../../ClimbListRow', () => ({ ClimbListRow: () => null }));

vi.mock('../../ClimbListRowSkeleton', () => ({
  ClimbListRowSkeleton: () => createElement('div', { 'data-skeleton-row': 'true' }),
}));

// icon-map is pure data but pulls in expo-symbols types via Icon's import chain;
// stub the entries the Material header maps to MaterialCommunityIcons glyphs so
// `iconMap[name].android` resolves without RN deps.
vi.mock('../../icon-map', () => ({
  iconMap: {
    'person.badge.plus': { ios: 'person.badge.plus', android: 'account-plus-outline' },
    'check.small': { ios: 'checkmark', android: 'check' },
    pin: { ios: 'pin', android: 'pin-outline' },
    'pin.fill': { ios: 'pin.fill', android: 'pin' },
    edit: { ios: 'pencil', android: 'pencil-outline' },
    delete: { ios: 'trash', android: 'delete-outline' },
  },
}));

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
    disabled,
  }: {
    icon?: string;
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) =>
    createElement('button', {
      'data-appbar-action': icon,
      onClick: onPress,
      'aria-label': accessibilityLabel,
      disabled: disabled ?? false,
    });
  // Render the anchor (the dots-vertical action) always; render the children
  // (menu items) only when `visible`, matching Paper's open/closed behaviour.
  const MenuComponent = ({
    visible,
    anchor,
    children,
  }: {
    visible?: boolean;
    anchor?: ReactNode;
    children?: ReactNode;
  }) => createElement('div', { 'data-menu': 'true' }, anchor ?? null, visible ? children : null);
  const MenuItem = ({ title, onPress }: { title?: ReactNode; onPress?: () => void }) =>
    createElement('button', { 'data-menu-item': 'true', onClick: onPress }, title);
  const Menu = Object.assign(MenuComponent, { Item: MenuItem });
  return { Appbar: { Header, BackAction, Content, Action }, Menu };
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

vi.mock('../PlaylistBoardBackdrop', () => ({
  PlaylistBoardBackdrop: ({ boardType }: { boardType: string }) => createElement('div', { 'data-backdrop': boardType }),
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

function makeProps(overrides: Partial<PlaylistDetailViewProps> = {}): PlaylistDetailViewProps {
  return {
    hero: {
      name: 'My Playlist',
      climbCount: 12,
      color: '#8C4A52',
    },
    climbs: [],
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

    // ── Material actions (regression: owners lost follow/pin/edit/delete) ──────

    it('renders inline materialActions as Appbar actions and wires onPress', () => {
      const onFollow = vi.fn();
      const onPin = vi.fn();
      const materialActions = {
        inline: [
          { key: 'follow', icon: 'person.badge.plus' as const, accessibilityLabel: 'Follow', onPress: onFollow },
          { key: 'pin', icon: 'pin' as const, accessibilityLabel: 'Pin playlist', onPress: onPin },
        ],
      };
      const { container } = render(<PlaylistDetailView {...makeProps({ materialActions })} />);
      const follow = container.querySelector('[data-appbar-action="account-plus-outline"]');
      const pin = container.querySelector('[data-appbar-action="pin-outline"]');
      expect(follow).not.toBeNull();
      expect(pin).not.toBeNull();
      fireEvent.click(follow as HTMLElement);
      fireEvent.click(pin as HTMLElement);
      expect(onFollow).toHaveBeenCalledTimes(1);
      expect(onPin).toHaveBeenCalledTimes(1);
    });

    it('disables an inline action when disabled is set', () => {
      const materialActions = {
        inline: [
          {
            key: 'follow',
            icon: 'person.badge.plus' as const,
            accessibilityLabel: 'Follow',
            onPress: vi.fn(),
            disabled: true,
          },
        ],
      };
      const { container } = render(<PlaylistDetailView {...makeProps({ materialActions })} />);
      const follow = container.querySelector('[data-appbar-action="account-plus-outline"]') as HTMLButtonElement;
      expect(follow.disabled).toBe(true);
    });

    it('renders an overflow menu anchor for owner edit/delete actions', () => {
      const materialActions = {
        menu: [
          { key: 'edit', title: 'Edit', icon: 'edit' as const, onPress: vi.fn() },
          { key: 'delete', title: 'Delete', icon: 'delete' as const, onPress: vi.fn(), destructive: true },
        ],
      };
      const { container } = render(<PlaylistDetailView {...makeProps({ materialActions })} />);
      // The dots-vertical anchor is present; menu items are hidden until opened.
      expect(container.querySelector('[data-appbar-action="dots-vertical"]')).not.toBeNull();
      expect(container.querySelectorAll('[data-menu-item]')).toHaveLength(0);
    });

    it('opens the overflow menu and fires the edit/delete handlers', () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn();
      const materialActions = {
        menu: [
          { key: 'edit', title: 'Edit', icon: 'edit' as const, onPress: onEdit },
          { key: 'delete', title: 'Delete', icon: 'delete' as const, onPress: onDelete, destructive: true },
        ],
      };
      const { container } = render(<PlaylistDetailView {...makeProps({ materialActions })} />);
      const openOverflow = () =>
        fireEvent.click(container.querySelector('[data-appbar-action="dots-vertical"]') as HTMLElement);
      // Open the menu → both items render → tapping one closes the menu (so the
      // next tap re-opens) and fires its handler.
      openOverflow();
      expect(container.querySelectorAll('[data-menu-item]')).toHaveLength(2);
      fireEvent.click(container.querySelectorAll('[data-menu-item]')[0] as HTMLElement);
      openOverflow();
      fireEvent.click(container.querySelectorAll('[data-menu-item]')[1] as HTMLElement);
      expect(onEdit).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('renders no overflow anchor when materialActions has no menu items', () => {
      const materialActions = {
        inline: [{ key: 'pin', icon: 'pin' as const, accessibilityLabel: 'Pin playlist', onPress: vi.fn() }],
      };
      const { container } = render(<PlaylistDetailView {...makeProps({ materialActions })} />);
      expect(container.querySelector('[data-appbar-action="dots-vertical"]')).toBeNull();
    });
  });
});
