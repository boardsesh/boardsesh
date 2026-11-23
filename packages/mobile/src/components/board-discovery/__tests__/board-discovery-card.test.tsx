// @vitest-environment jsdom
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode, type RefObject } from 'react';
import type { AppMenuAction, AppMenuHandle } from '../../AppMenu.types';
import type { BoardCardMenuCapabilities, BoardCardMenuLabels } from '../board-card-menu';
import type { BoardCardMenu, DiscoveryBoardItem } from '../BoardDiscoveryCard';

// Capture the props the card hands to BoardImageNative. The regression is that
// the discovery card omitted renderWidth, so the native renderer resolved the
// full-res board background (~1080-1461px) into a 168px cell on the main thread.
const boardImageProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
// The card Pressable, which is where the accessibility contract lives: on iOS
// UIKit treats it as a leaf, so the menu rows are only reachable through its
// custom actions.
const cardRootProps = vi.hoisted(() => ({
  last: null as Record<string, unknown> | null,
  accessibilityActions: [] as unknown[],
}));
type CapturedMenu = {
  actions: AppMenuAction[];
  onSelectIndex: (index: number) => void;
  trigger?: 'longPress';
  menuKey?: string;
  liftPreview?: boolean;
  iconName?: string;
  accessibilityLabel?: string;
  menuRef?: RefObject<AppMenuHandle | null>;
};
const menus = vi.hoisted(() => ({
  hold: null as CapturedMenu | null,
  button: null as CapturedMenu | null,
  open: vi.fn(),
}));
// Mutable, so one suite can render the Android path.
const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));

function styleAttribute(style: unknown): string {
  return JSON.stringify(style);
}

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.OS;
    },
    select: (spec: Record<string, unknown>) => spec[platform.OS] ?? spec.default,
  },
  View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
    createElement('div', { 'data-style': styleAttribute(style), 'data-testid': testID }, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

// Reanimated host components: passthrough + no-op hooks so the card renders in
// jsdom without the native runtime. The animated Pressable keeps its onPress, so
// "a menu row fires onAction and NOT onPress" is actually falsifiable.
vi.mock('react-native-reanimated', () => ({
  default: {
    createAnimatedComponent: () => (props: Record<string, unknown>) => {
      cardRootProps.last = props;
      cardRootProps.accessibilityActions.push(props.accessibilityActions);
      return createElement(
        'div',
        {
          onClick: props.onPress as (() => void) | undefined,
          'aria-label': props.accessibilityLabel as string | undefined,
          'data-role': (props.accessibilityRole as string | undefined) ?? '',
          'data-testid': 'card-root',
        },
        props.children as ReactNode,
      );
    },
  },
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initial: unknown) => ({ value: initial }),
  withSpring: (toValue: unknown) => toValue,
}));

// One stub for both menus the card draws. The hold menu wraps the card; the ⋯
// is a separate anchor. Their props are captured so a test can pick a row the
// way the native menu would.
vi.mock('../../AppMenu', () => ({
  AppMenu: (props: CapturedMenu & { children?: ReactNode }) => {
    if (props.trigger === 'longPress') {
      menus.hold = props;
      if (props.menuRef) props.menuRef.current = { open: menus.open };
      return createElement('div', { 'data-testid': 'hold-menu' }, props.children);
    }
    menus.button = props;
    return createElement('button', { 'data-testid': 'menu-button', 'aria-label': props.accessibilityLabel });
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => {
      const template =
        {
          'mobile.discovery.onIt': 'On it',
          'mobile.discovery.ownedBadgeAria': 'Your board',
          'mobile.discovery.followingBadgeAria': 'Following',
          'mobile.discovery.pinnedBadgeAria': 'Pinned',
          'mobile.discovery.cardActionsAria': 'Actions for {{name}}',
          'mobile.offline.available': 'Available offline',
          'mobile.offline.pending': 'Waiting to download',
          'mobile.offline.bootstrapping': 'Downloading board…',
          'mobile.offline.finalizing': 'Finishing download…',
        }[key] ?? key;
      return options?.name === undefined ? template : template.replace('{{name}}', options.name);
    },
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 4 }),
  borderRadius: { lg: 12, md: 8, full: 999 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: {
      tertiaryBackground: '#eee',
      separator: '#ccc',
      tertiaryLabel: '#999',
      secondaryLabel: '#888',
    },
    brandColors: { primary: '#6D28D9', primaryFill: '#6D28D9', onPrimary: '#FFFFFF', error: '#C81E1E' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color, style }: { children?: ReactNode; color?: string; style?: unknown }) =>
    createElement('span', { 'data-color': color, 'data-style': styleAttribute(style) }, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

// A non-null render keeps the card on the BoardImageNative branch.
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 1461, boardHeight: 1144 }),
}));
vi.mock('../../../lib/spray/use-spray-wall-thumbnail', () => ({ useSprayWallThumbnail: () => null }));

vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: (props: Record<string, unknown>) => {
    boardImageProps.last = props;
    return createElement('div', { 'data-testid': 'board-image' });
  },
}));

import { BoardDiscoveryCard } from '../BoardDiscoveryCard';

const item: DiscoveryBoardItem = {
  key: 'board-uuid',
  boardName: 'tension',
  layoutId: 9,
  sizeId: 8,
  setIds: '1,2',
  title: 'Tension 8x10',
  subtitle: 'Original 12x12',
};

const LABELS: BoardCardMenuLabels = {
  climbHere: 'Climb here',
  pin: 'Pin',
  unpin: 'Unpin',
  download: 'Download for offline',
  details: 'Details',
  edit: 'Edit board',
  editWall: 'Edit Spraywall',
  removeFromGym: 'Remove from gym',
  removeFromNamedGym: (gymName) => `Remove from ${gymName}`,
  unfollow: 'Remove from your boards',
  delete: 'Delete',
  reviewReports: 'See reports',
  report: 'Report a problem',
  reported: 'Reported',
};
const EVERYTHING: BoardCardMenuCapabilities = {
  canPin: true,
  canDownload: true,
  canOpenDetails: true,
  canManage: true,
  canReport: false,
};
const NEARBY: BoardCardMenuCapabilities = {
  canPin: false,
  canDownload: false,
  canOpenDetails: true,
  canManage: false,
  canReport: false,
};

function menuWith(capabilities: BoardCardMenuCapabilities = EVERYTHING): BoardCardMenu {
  return { capabilities, labels: LABELS, onAction: vi.fn() };
}

function styleOf(element: Element | null): Record<string, unknown> {
  const raw = element?.getAttribute('data-style');
  if (raw === null || raw === undefined) return {};
  const parsed: unknown = JSON.parse(raw);
  return (Array.isArray(parsed) ? Object.assign({}, ...parsed.filter((entry) => entry !== null)) : parsed) as Record<
    string,
    unknown
  >;
}

/** The subtitle line's glyphs and text, in the order they render. */
function subtitleSequence(container: HTMLElement): string[] {
  const line = container.querySelector('[data-testid="board-card-subtitle"]');
  if (!line) return [];
  return [...line.children].map((child) => child.getAttribute('data-icon') ?? child.textContent ?? '');
}

function a11yActions(): { name: string; label?: string }[] {
  return (cardRootProps.last?.accessibilityActions ?? []) as { name: string; label?: string }[];
}

function dispatchA11y(actionName: string) {
  const handler = cardRootProps.last?.onAccessibilityAction as (event: { nativeEvent: { actionName: string } }) => void;
  handler({ nativeEvent: { actionName } });
}

function resetCapture() {
  cleanup();
  boardImageProps.last = null;
  cardRootProps.last = null;
  cardRootProps.accessibilityActions = [];
  menus.hold = null;
  menus.button = null;
  menus.open.mockReset();
  platform.OS = 'ios';
}

describe('BoardDiscoveryCard', () => {
  afterEach(resetCapture);

  it('renders the thumbnail at a small renderWidth, not the full-res board source', () => {
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn() }));

    expect(boardImageProps.last).not.toBeNull();
    // The discovery card cell is 168px; requesting renderWidth forces the
    // thumb-variant background + small overlay instead of a full-res decode.
    expect(boardImageProps.last?.renderWidth).toBe(400);
  });

  it('activates the board from a tap', () => {
    const onPress = vi.fn();
    const { getByTestId } = render(createElement(BoardDiscoveryCard, { item, onPress, menu: menuWith() }));
    fireEvent.click(getByTestId('card-root'));
    expect(onPress).toHaveBeenCalledWith(item);
  });
});

describe('BoardDiscoveryCard board art', () => {
  afterEach(resetCapture);

  // The whole point of the redesign: every state and every control used to sit
  // on the art. Now the thumb holds the board image and nothing else.
  it('draws nothing on the board art, whatever the board state', () => {
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, {
        item: {
          ...item,
          isActive: true,
          isPinned: true,
          isViewerOwner: true,
          offlineState: 'off',
          distanceMeters: 1500,
        },
        onPress: vi.fn(),
        menu: menuWith(),
      }),
    );
    const thumb = getByTestId('board-card');
    expect(thumb.querySelectorAll('[data-icon]')).toHaveLength(0);
    expect(thumb.querySelectorAll('[data-testid="menu-button"]')).toHaveLength(0);
    expect(thumb.textContent).toBe('');
    expect(thumb.querySelector('[data-testid="board-image"]')).not.toBeNull();
  });

  // Selection is a state, not a link: no violet border, no violet title. "On it"
  // in the subtitle says it, in secondary label.
  it('draws the board you are on like any other card, with no violet', () => {
    const { getByTestId, getByText } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, isActive: true }, onPress: vi.fn() }),
    );
    expect(styleOf(getByTestId('board-card'))).toMatchObject({ borderColor: '#ccc' });
    expect(styleOf(getByTestId('board-card')).borderWidth).not.toBe(2);
    expect(getByText('Tension 8x10').getAttribute('data-color')).toBeNull();
    expect(getByText('On it ·').getAttribute('data-color')).not.toBe('#6D28D9');
  });

  it('leaves an inactive title in the default colour', () => {
    const { getByText } = render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn() }));
    expect(getByText('Tension 8x10').getAttribute('data-color')).toBeNull();
  });
});

describe('BoardDiscoveryCard subtitle line', () => {
  afterEach(resetCapture);

  it('leads with the state glyphs in order: on it, pinned, downloaded, then the distance and subtitle', () => {
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isActive: true, isPinned: true, offlineState: 'downloaded', distanceMeters: 2 },
        onPress: vi.fn(),
      }),
    );
    expect(subtitleSequence(container)).toEqual([
      'tick.fill',
      'On it ·',
      'pin.fill',
      'offline.downloaded',
      '2 m · Original 12x12',
    ]);
  });

  it.each([
    ['downloading', 'offline.pending'],
    ['finalizing', 'offline.pending'],
    ['pending', 'offline.pending'],
    ['downloaded', 'offline.downloaded'],
  ] as const)('shows a %s board with %s', (offlineState, icon) => {
    const { container } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, offlineState }, onPress: vi.fn() }),
    );
    expect(subtitleSequence(container)).toEqual([icon, 'Original 12x12']);
  });

  // Not on the phone is the default, not a state worth a glyph. The download
  // itself lives in the menu.
  it('draws no offline glyph for a board that is not downloaded', () => {
    const { container } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, offlineState: 'off' }, onPress: vi.fn(), menu: menuWith() }),
    );
    expect(subtitleSequence(container)).toEqual(['Original 12x12']);
    expect(container.querySelector('[data-icon="offline.download"]')).toBeNull();
  });

  it.each([
    [2.4, '2 m · Original 12x12'],
    [999, '999 m · Original 12x12'],
    [3240, '3.2 km · Original 12x12'],
  ])('prints %s metres as "%s"', (distanceMeters, expected) => {
    const { container } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, distanceMeters }, onPress: vi.fn() }),
    );
    expect(subtitleSequence(container)).toEqual([expected]);
  });

  it('drops the separator after "On it" when nothing follows it', () => {
    const { container } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, subtitle: null, isActive: true }, onPress: vi.fn() }),
    );
    expect(subtitleSequence(container)).toEqual(['tick.fill', 'On it']);
  });

  it('renders no subtitle line for a board with nothing to say there', () => {
    const { container } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, subtitle: null }, onPress: vi.fn() }),
    );
    expect(container.querySelector('[data-testid="board-card-subtitle"]')).toBeNull();
  });
});

describe('BoardDiscoveryCard menu', () => {
  beforeEach(resetCapture);
  afterEach(resetCapture);

  it('draws no menu at all where the carousel offers none', () => {
    const { queryByTestId } = render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn() }));
    expect(queryByTestId('menu-button')).toBeNull();
    expect(queryByTestId('hold-menu')).toBeNull();
  });

  it('puts the ⋯ beside the title, outside the card Pressable, labelled with the board', () => {
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isViewerOwner: true, offlineState: 'off' },
        onPress: vi.fn(),
        menu: menuWith(),
      }),
    );
    const button = getByTestId('menu-button');
    expect(button.getAttribute('aria-label')).toBe('Actions for Tension 8x10');
    // Nested inside the Pressable, the card took the tap and picked the board.
    expect(getByTestId('card-root').contains(button)).toBe(false);
    expect(menus.button?.iconName).toBe('more');
  });

  it('hands both ways in the same rows, in menu order', () => {
    render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isViewerOwner: true, offlineState: 'off' },
        onPress: vi.fn(),
        menu: menuWith(),
      }),
    );
    const labels = ['Climb here', 'Pin', 'Download for offline', 'Details', 'Edit board', 'Delete'];
    expect(menus.button?.actions.map((action) => action.label)).toEqual(labels);
    expect(menus.hold?.actions).toBe(menus.button?.actions);
    // No lifted preview: on iOS it paints a background behind the card at rest,
    // a grey slab under the title inside the picker modal.
    expect(menus.hold?.liftPreview).toBeUndefined();
    expect(menus.hold?.menuKey).toBe('board-uuid');
    const deleteRow = menus.button?.actions[5];
    expect(deleteRow).toMatchObject({ destructive: true, dividerBefore: true, systemIcon: 'trash' });
  });

  it('calls a spray wall a Spraywall in its edit row', () => {
    render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, boardName: 'spray', isViewerOwner: true, offlineState: 'downloaded' },
        onPress: vi.fn(),
        menu: menuWith(),
      }),
    );
    expect(menus.button?.actions.map((action) => action.label)).toContain('Edit Spraywall');
  });

  it('offers only Climb here and Details on a Near you card', () => {
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), menu: menuWith(NEARBY) }));
    expect(menus.button?.actions.map((action) => action.label)).toEqual(['Climb here', 'Details']);
  });

  // A ⋯ whose only row repeats the tap adds nothing, so it is not drawn. The
  // hold anchor stays mounted with no rows, so a recycled cell never remounts.
  it('draws no ⋯ when the menu would only repeat the tap', () => {
    const { queryByTestId, getByText } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, offlineState: 'downloaded' },
        onPress: vi.fn(),
        menu: menuWith({ canPin: false, canDownload: true, canOpenDetails: false, canManage: false, canReport: false }),
      }),
    );
    expect(queryByTestId('menu-button')).toBeNull();
    expect(queryByTestId('hold-menu')).not.toBeNull();
    expect(menus.hold?.actions).toEqual([]);
    expect(a11yActions().map((action) => action.name)).toEqual([]);
    // The title gets the full card width back.
    expect(styleOf(getByText('Tension 8x10')).marginRight).toBeUndefined();
  });

  it('reserves the ⋯ width beside the title only while the ⋯ is there', () => {
    const { getByText } = render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), menu: menuWith(NEARBY) }));
    expect(styleOf(getByText('Tension 8x10')).marginRight).toBe(44);
  });

  it('runs a row from the ⋯ as menu_button and never activates the board', () => {
    const onPress = vi.fn();
    const menu = menuWith();
    const pinnedItem = { ...item, isViewerOwner: false, isPinned: true, offlineState: 'downloaded' as const };
    render(createElement(BoardDiscoveryCard, { item: pinnedItem, onPress, menu }));
    const labels = menus.button?.actions.map((action) => action.label) ?? [];
    expect(labels).toEqual(['Climb here', 'Unpin', 'Details', 'Remove from your boards']);

    menus.button?.onSelectIndex(1);
    expect(menu.onAction).toHaveBeenCalledWith(pinnedItem, 'unpin', 'menu_button');
    menus.button?.onSelectIndex(3);
    expect(menu.onAction).toHaveBeenLastCalledWith(pinnedItem, 'unfollow', 'menu_button');
    expect(onPress).not.toHaveBeenCalled();
  });

  it('runs a row from the hold as long_press', () => {
    const menu = menuWith(NEARBY);
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), menu }));
    menus.hold?.onSelectIndex(0);
    expect(menu.onAction).toHaveBeenCalledWith(item, 'climb_here', 'long_press');
    menus.hold?.onSelectIndex(1);
    expect(menu.onAction).toHaveBeenLastCalledWith(item, 'details', 'long_press');
  });

  // iOS: the SwiftUI context menu owns the hold, and the card adds nothing.
  it('leaves the hold to the native context menu on iOS', () => {
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), menu: menuWith(NEARBY) }));
    expect(cardRootProps.last?.onLongPress).toBeUndefined();
  });

  // Android: the card's own Pressable wins the touch, so the menu's wrapper
  // never sees the hold. The card opens the menu itself.
  it('opens the menu from a hold on Android', () => {
    platform.OS = 'android';
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), menu: menuWith(NEARBY) }));
    const onLongPress = cardRootProps.last?.onLongPress as (() => void) | undefined;
    expect(onLongPress).toBeTypeOf('function');
    // The same hold as AppMenu.android's own wrapper and the browser menu.
    expect(cardRootProps.last?.delayLongPress).toBe(400);
    onLongPress?.();
    expect(menus.open).toHaveBeenCalledTimes(1);
  });

  it('gives the hold nothing to open on Android when there are no rows', () => {
    platform.OS = 'android';
    render(
      createElement(BoardDiscoveryCard, {
        item,
        onPress: vi.fn(),
        menu: menuWith({
          canPin: false,
          canDownload: false,
          canOpenDetails: false,
          canManage: false,
          canReport: false,
        }),
      }),
    );
    expect(cardRootProps.last?.onLongPress).toBeUndefined();
  });
});

describe('BoardDiscoveryCard accessibility', () => {
  afterEach(resetCapture);

  // No glyph says owned or followed any more, so the label has to.
  it.each([
    [true, 'Your board'],
    [false, 'Following'],
  ])('announces ownership in the composed label (owner=%s)', (isViewerOwner, expected) => {
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, isViewerOwner }, onPress: vi.fn() }),
    );
    expect(getByTestId('card-root').getAttribute('aria-label')).toBe(`Tension 8x10, Original 12x12, ${expected}`);
  });

  it('announces every state the subtitle glyphs show, and omits ownership it cannot resolve', () => {
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isActive: true, isPinned: true, offlineState: 'downloaded', distanceMeters: 3240 },
        onPress: vi.fn(),
      }),
    );
    expect(getByTestId('card-root').getAttribute('aria-label')).toBe(
      'Tension 8x10, On it, 3.2 km, Original 12x12, Pinned, Available offline',
    );
  });

  it.each([
    ['downloading', 'Downloading board…'],
    ['finalizing', 'Finishing download…'],
    ['pending', 'Waiting to download'],
  ] as const)('announces a %s board', (offlineState, expected) => {
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, subtitle: null, offlineState }, onPress: vi.fn() }),
    );
    expect(getByTestId('card-root').getAttribute('aria-label')).toBe(`Tension 8x10, ${expected}`);
  });

  // The card is a leaf to VoiceOver, so every menu row has to be a labelled
  // custom action or a screen-reader user can only reach it with the hold.
  it('publishes every menu row but Climb here as a custom action', () => {
    render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isViewerOwner: true, offlineState: 'off' },
        onPress: vi.fn(),
        menu: menuWith(),
      }),
    );
    expect(a11yActions()).toEqual([
      { name: 'pin', label: 'Pin' },
      { name: 'download', label: 'Download for offline' },
      { name: 'details', label: 'Details' },
      { name: 'edit', label: 'Edit board' },
      { name: 'delete', label: 'Delete' },
    ]);
  });

  it('routes each custom action to the menu as accessibility, and activate to the tap', () => {
    const onPress = vi.fn();
    const menu = menuWith();
    const followedItem = { ...item, isViewerOwner: false, offlineState: 'off' as const };
    render(createElement(BoardDiscoveryCard, { item: followedItem, onPress, menu }));

    dispatchA11y('unfollow');
    expect(menu.onAction).toHaveBeenCalledWith(followedItem, 'unfollow', 'accessibility');
    dispatchA11y('download');
    expect(menu.onAction).toHaveBeenLastCalledWith(followedItem, 'download', 'accessibility');
    expect(onPress).not.toHaveBeenCalled();

    dispatchA11y('activate');
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(menu.onAction).toHaveBeenCalledTimes(2);
  });

  // An action name the card did not publish (a stale rotor entry, or Climb
  // here, which is the card's own activation) runs nothing.
  it('ignores an action the card does not offer', () => {
    const menu = menuWith(NEARBY);
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), menu }));
    dispatchA11y('delete');
    dispatchA11y('climb_here');
    expect(menu.onAction).not.toHaveBeenCalled();
  });

  it('publishes no custom actions on a card with no menu', () => {
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn() }));
    // ACTIVATE_ACCESSIBILITY_ACTIONS: undefined on iOS, where double-tap is enough.
    expect(cardRootProps.last?.accessibilityActions).toBeUndefined();
  });

  it('keeps one accessibilityActions identity across re-renders', () => {
    const menu = menuWith();
    const onPress = vi.fn();
    const ownedItem = { ...item, isViewerOwner: true };
    const { rerender } = render(createElement(BoardDiscoveryCard, { item: { ...ownedItem }, onPress, menu }));
    // A fresh item object breaks the memo, so the component really does re-render;
    // the actions array must not churn with it.
    rerender(createElement(BoardDiscoveryCard, { item: { ...ownedItem }, onPress, menu }));
    expect(cardRootProps.accessibilityActions).toHaveLength(2);
    expect(cardRootProps.accessibilityActions[0]).toBe(cardRootProps.accessibilityActions[1]);
  });
});

const importProgress = {
  wallUuid: 'spray-wall',
  versionId: '42',
  detectionId: 'detection',
  stage: 'queued' as const,
  queuePosition: 3,
  retryAt: null,
  resetOfWallUuid: null,
};

describe('BoardDiscoveryCard import status', () => {
  afterEach(resetCapture);

  it('hands the exact unfinished import to the picker and masks stale ranks', () => {
    const onPress = vi.fn();
    const importItem = {
      ...item,
      boardName: 'spray' as const,
      isViewerOwner: true,
      sprayImport: importProgress,
      importStatusStale: true,
    };
    const { getByText, getByTestId } = render(
      createElement(BoardDiscoveryCard, { item: importItem, onPress, menu: menuWith() }),
    );
    expect(getByText('sprayImport.offline')).toBeTruthy();
    // Climbing, downloading and details do not apply to a wall still importing;
    // pinning and removing it do.
    expect(menus.button?.actions.map((action) => action.label)).toEqual(['Pin', 'Edit Spraywall', 'Delete']);
    expect(a11yActions().map((action) => action.name)).not.toContain('details');
    fireEvent.click(getByTestId('card-root'));
    expect(onPress).toHaveBeenCalledWith(importItem);
  });

  it('opens a reset clone like any import, with no Details action', () => {
    const onPress = vi.fn();
    const resetItem = {
      ...item,
      boardName: 'spray' as const,
      sprayImport: { ...importProgress, resetOfWallUuid: 'old-wall', stage: 'ready' as const },
    };
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, { item: resetItem, onPress, menu: menuWith(NEARBY) }),
    );
    // Near you capabilities on an import leave nothing beyond the tap.
    expect(menus.button).toBeNull();
    expect(a11yActions().map((action) => action.name)).toEqual([]);
    fireEvent.click(getByTestId('card-root'));
    expect(onPress).toHaveBeenCalledWith(resetItem);
  });
});
