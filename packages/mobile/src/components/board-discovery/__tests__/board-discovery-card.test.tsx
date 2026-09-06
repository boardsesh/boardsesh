// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { DiscoveryBoardItem } from '../BoardDiscoveryCard';

// Capture the props the card hands to BoardImageNative. The regression is that
// the discovery card omitted renderWidth, so the native renderer resolved the
// full-res board background (~1080-1461px) into a 168px cell on the main thread.
const boardImageProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
// The outer card Pressable, which is where the accessibility contract lives: on
// iOS UIKit treats it as a leaf, so the corner glyphs are only reachable through
// its custom actions.
const cardRootProps = vi.hoisted(() => ({
  last: null as Record<string, unknown> | null,
  accessibilityActions: [] as unknown[],
}));

// `style` is forwarded onto a data attribute so corner placement can be asserted
// by WHICH edge keys are present — never pixel values, since the spacing mock is
// a constant. `disabled` too: a disabled control has to stop firing, not just
// look different.
function styleAttribute(style: unknown): string {
  return JSON.stringify(style);
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
    createElement('div', { 'data-style': styleAttribute(style), 'data-testid': testID }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
    style?: unknown;
  }) =>
    createElement(
      'div',
      {
        // Nested-press exclusivity: RN's responder system grants the press to the
        // deepest Pressable and the outer card's onPress never fires. jsdom
        // bubbles instead, so stop it here or every corner-glyph tap would also
        // read as a card tap.
        onClick:
          disabled === true
            ? undefined
            : (event: { stopPropagation: () => void }) => {
                event.stopPropagation();
                onPress?.();
              },
        'aria-label': accessibilityLabel,
        'aria-disabled': disabled === true ? 'true' : undefined,
        'data-style': styleAttribute(style),
        role: 'button',
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

// Reanimated host components: passthrough + no-op hooks so the card renders in
// jsdom without the native runtime. The animated Pressable keeps its onPress, so
// "the action fires onAction and NOT onPress" is actually falsifiable.
vi.mock('react-native-reanimated', () => ({
  default: {
    createAnimatedComponent: () => (props: Record<string, unknown>) => {
      cardRootProps.last = props;
      cardRootProps.accessibilityActions.push(props.accessibilityActions);
      return createElement(
        'div',
        {
          onClick: props.disabled === true ? undefined : (props.onPress as (() => void) | undefined),
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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'mobile.discovery.activeBadge': 'Active',
        'mobile.discovery.ownedBadgeAria': 'Your board',
        'mobile.discovery.followingBadgeAria': 'Following',
      })[key] ?? key,
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticHeavy: vi.fn() }));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 4 }),
  borderRadius: { lg: 12, md: 8, full: 999 },
  overlays: { scrim: '#0008', onScrim: '#fff' },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string, alpha: number) => `${color}/${alpha}` }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { tertiaryBackground: '#eee', separator: '#ccc', tertiaryLabel: '#999', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9', primaryFill: '#6D28D9', onPrimary: '#FFFFFF', error: '#C81E1E' },
    radii: { button: 10 },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('span', { 'data-testid': 'spinner' }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) =>
    createElement(
      'div',
      {
        onClick:
          disabled === true
            ? undefined
            : (event: { stopPropagation: () => void }) => {
                event.stopPropagation();
                onPress?.();
              },
        'aria-label': accessibilityLabel,
        'aria-disabled': disabled === true ? 'true' : undefined,
        'data-testid': 'edit-action',
        role: 'button',
      },
      children,
    ),
}));

// A non-null render keeps the card on the BoardImageNative branch.
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 1461, boardHeight: 1144 }),
}));

vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: (props: Record<string, unknown>) => {
    boardImageProps.last = props;
    return createElement('div', { 'data-testid': 'board-image' });
  },
}));

import { BoardDiscoveryCard } from '../BoardDiscoveryCard';

const item: DiscoveryBoardItem = {
  key: 'popular:tension:9:8:1-2',
  boardName: 'tension',
  layoutId: 9,
  sizeId: 8,
  setIds: '1,2',
  title: 'Tension 8x10',
};

function styleOf(element: Element | null): Record<string, unknown> {
  const raw = element?.getAttribute('data-style');
  if (raw === null || raw === undefined) return {};
  const parsed: unknown = JSON.parse(raw);
  // A Pressable's style can be an array (base + a state override); flatten it the
  // way RN would so an assertion reads the value that actually renders.
  return (Array.isArray(parsed) ? Object.assign({}, ...parsed.filter((entry) => entry !== null)) : parsed) as Record<
    string,
    unknown
  >;
}

function edgeKeys(element: Element | null): string[] {
  const style = styleOf(element);
  return ['top', 'bottom', 'left', 'right'].filter((edge) => style[edge] !== undefined);
}

/** The disc geometry every tappable corner glyph shares (#5179). */
function discShape(element: Element | null): Record<string, unknown> {
  const { width, height, borderRadius } = styleOf(element);
  return { width, height, borderRadius };
}

function resetCapture() {
  cleanup();
  boardImageProps.last = null;
  cardRootProps.last = null;
  cardRootProps.accessibilityActions = [];
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

  // The badge answers "is this board on my phone" without leaving the picker.
  it.each([
    ['downloaded', 'offline.downloaded'],
    ['downloading', 'offline.pending'],
    ['finalizing', 'offline.pending'],
    ['pending', 'offline.pending'],
  ] as const)('shows a status badge for a %s board', (offlineState, icon) => {
    const { container } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, offlineState }, onPress: vi.fn() }),
    );
    expect(container.querySelector(`[data-icon="${icon}"]`)).not.toBeNull();
  });

  it('has no press target on a board that is already downloading', () => {
    const onDownload = vi.fn();
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, offlineState: 'downloading' },
        onPress: vi.fn(),
        onDownload,
      }),
    );
    fireEvent.click(container.querySelector('[data-icon="offline.pending"]')!.parentElement!);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it('offers a tappable download glyph only where the host wired one', () => {
    const onDownload = vi.fn();
    const downloadItem = { ...item, offlineState: 'off' as const };

    const withoutHandler = render(createElement(BoardDiscoveryCard, { item: downloadItem, onPress: vi.fn() }));
    expect(withoutHandler.container.querySelector('[data-icon="offline.download"]')).toBeNull();
    cleanup();

    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: downloadItem,
        onPress: vi.fn(),
        onDownload,
        downloadLabel: 'Make Tension 8x10 available offline',
      }),
    );
    const glyph = container.querySelector('[data-icon="offline.download"]')!.parentElement!;
    expect(glyph.getAttribute('aria-label')).toBe('Make Tension 8x10 available offline');
    fireEvent.click(glyph);
    expect(onDownload).toHaveBeenCalledWith(downloadItem);
  });

  // A popular config has no uuid, so rememberOfflineBoards drops it: its data
  // would download but the board could never appear in the offline picker.
  it('renders no offline affordance at all without an offlineState', () => {
    const { container } = render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), onDownload: vi.fn() }));
    expect(container.querySelector('[data-icon="offline.download"]')).toBeNull();
    expect(container.querySelector('[data-icon="offline.downloaded"]')).toBeNull();
  });
});

describe('BoardDiscoveryCard ownership action', () => {
  afterEach(resetCapture);

  it.each([
    ['edit', 'edit'],
    ['unfollow', 'person.check'],
  ] as const)('renders the %s glyph in the top-right slot', (action, icon) => {
    const { container } = render(
      createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), action, onAction: vi.fn() }),
    );
    expect(container.querySelector(`[data-icon="${icon}"]`)).not.toBeNull();
  });

  it('renders no slot without an action, and no pencil without a handler', () => {
    const withoutAction = render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), onAction: vi.fn() }));
    expect(withoutAction.container.querySelector('[data-icon="edit"]')).toBeNull();
    expect(withoutAction.container.querySelector('[data-icon="person.check"]')).toBeNull();
    cleanup();

    const withoutHandler = render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), action: 'edit' }));
    expect(withoutHandler.container.querySelector('[data-icon="edit"]')).toBeNull();
  });

  // The whole point of B1: a 26pt disc that sits in the same white circle as the
  // non-interactive download-status badge on the opposite corner must not remove
  // a board in one unconfirmed tap. Unfollow lives on Edit mode's labelled
  // button; the resting glyph is status only.
  it('makes the Following glyph non-interactive — no press target, no button role', () => {
    const onAction = vi.fn();
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item,
        onPress: vi.fn(),
        action: 'unfollow',
        onAction,
        actionLabel: 'Unfollow Tension 8x10',
      }),
    );
    const badge = container.querySelector('[data-icon="person.check"]')!.parentElement!;
    expect(badge.getAttribute('role')).toBeNull();
    expect(badge.getAttribute('aria-label')).toBeNull();
    fireEvent.click(badge);
    expect(onAction).not.toHaveBeenCalled();
  });

  // ...and it publishes no custom action either, or VoiceOver would hand back the
  // one-tap unfollow the touch surface just gave up.
  it('publishes no board action for a resting followed board', () => {
    render(
      createElement(BoardDiscoveryCard, {
        item,
        onPress: vi.fn(),
        action: 'unfollow',
        onAction: vi.fn(),
        actionLabel: 'Unfollow Tension 8x10',
      }),
    );
    const actions = (cardRootProps.last?.accessibilityActions ?? []) as { name: string }[];
    expect(actions.map((entry) => entry.name)).not.toContain('boardAction');
  });

  it('fires onAction and never onPress when the slot is tapped', () => {
    const onPress = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item,
        onPress,
        action: 'edit',
        onAction,
        actionLabel: 'Edit Tension 8x10',
      }),
    );
    const badge = container.querySelector('[data-icon="edit"]')!.parentElement!;
    expect(badge.getAttribute('aria-label')).toBe('Edit Tension 8x10');
    fireEvent.click(badge);
    expect(onAction).toHaveBeenCalledWith(item);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('BoardDiscoveryCard edit mode', () => {
  afterEach(resetCapture);

  // The whole point of a footer button over a corner ⊖: the control says what it
  // does. Unfollow has no confirm outside the active board, so an unlabelled red
  // glyph on an ungrouped carousel would silently remove a gym.
  it('replaces the corner badge with a labelled destructive button', () => {
    const { container, getByTestId } = render(
      createElement(BoardDiscoveryCard, {
        item,
        onPress: vi.fn(),
        action: 'delete',
        onAction: vi.fn(),
        actionLabel: 'Delete Tension 8x10',
        actionTitle: 'Delete',
        isEditing: true,
      }),
    );
    expect(container.querySelector('[data-icon="edit"]')).toBeNull();
    expect(container.querySelector('[data-icon="person.check"]')).toBeNull();
    const footer = getByTestId('edit-action');
    expect(footer.textContent).toContain('Delete');
    expect(footer.getAttribute('aria-label')).toBe('Delete Tension 8x10');
  });

  it('fires onAction from the footer button', () => {
    const onAction = vi.fn();
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, {
        item,
        onPress: vi.fn(),
        action: 'unfollow',
        onAction,
        actionTitle: 'Unfollow',
        isEditing: true,
      }),
    );
    fireEvent.click(getByTestId('edit-action'));
    expect(onAction).toHaveBeenCalledWith(item);
  });

  it('swaps the footer label for a spinner and stops firing while a mutation is in flight', () => {
    const onAction = vi.fn();
    const { container, getByTestId } = render(
      createElement(BoardDiscoveryCard, {
        item,
        onPress: vi.fn(),
        action: 'delete',
        onAction,
        actionTitle: 'Delete',
        isEditing: true,
        isActionPending: true,
      }),
    );
    expect(container.querySelector('[data-icon="minus.circle"]')).toBeNull();
    const footer = getByTestId('edit-action');
    expect(footer.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(footer);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('stops the card body activating the board', () => {
    const onPress = vi.fn();
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, {
        item,
        onPress,
        action: 'delete',
        onAction: vi.fn(),
        actionTitle: 'Delete',
        isEditing: true,
      }),
    );
    const root = getByTestId('card-root');
    // Not just an early-returning handler: the role goes too, so the card stops
    // being announced as a button.
    expect(root.getAttribute('data-role')).toBe('');
    fireEvent.click(root);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('BoardDiscoveryCard corner budget', () => {
  afterEach(resetCapture);

  // An active board can also be a Near-you board, so both bottom pills can land
  // on one thumb. They sit at opposite corners and never stack.
  it('puts the Active pill bottom-left and the distance pill bottom-right', () => {
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isActive: true, distanceMeters: 320 },
        onPress: vi.fn(),
      }),
    );
    const activePill = container.querySelector('[data-icon="tick"]')!.parentElement;
    const distancePill = container.querySelector('[data-icon="location"]')!.parentElement;
    expect(edgeKeys(activePill)).toEqual(['bottom', 'left']);
    expect(edgeKeys(distancePill)).toEqual(['bottom', 'right']);
  });

  it('puts the offline badge top-left and the ownership slot top-right', () => {
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, offlineState: 'downloaded' },
        onPress: vi.fn(),
        action: 'edit',
        onAction: vi.fn(),
      }),
    );
    const offlineBadge = container.querySelector('[data-icon="offline.downloaded"]')!.parentElement;
    const actionBadge = container.querySelector('[data-icon="edit"]')!.parentElement;
    expect(edgeKeys(offlineBadge)).toEqual(['top', 'left']);
    expect(edgeKeys(actionBadge)).toEqual(['top', 'right']);
  });
});

describe('BoardDiscoveryCard pin toggle', () => {
  afterEach(resetCapture);

  it('renders no pin control unless the host passes a handler', () => {
    // Near you, Popular, onboarding and the offline branch all omit it; the
    // absent handler is the gate, so there is nothing to talk past.
    const { container } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, isPinned: false }, onPress: vi.fn() }),
    );
    expect(container.querySelector('[data-icon="pin"]')).toBeNull();
    expect(container.querySelector('[data-icon="pin.fill"]')).toBeNull();
  });

  it('shows an outline pin when unpinned and a filled one when pinned', () => {
    const { container, rerender } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isPinned: false },
        onPress: vi.fn(),
        onTogglePin: vi.fn(),
        pinLabel: 'Pin Tension 8x10',
      }),
    );
    expect(container.querySelector('[data-icon="pin"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="pin.fill"]')).toBeNull();

    rerender(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isPinned: true },
        onPress: vi.fn(),
        onTogglePin: vi.fn(),
        pinLabel: 'Unpin Tension 8x10',
      }),
    );
    expect(container.querySelector('[data-icon="pin.fill"]')).not.toBeNull();
  });

  it('takes the bottom-right slot, and yields it to the distance pill', () => {
    // The pin takes the bottom-right slot rather than adding a fifth corner, so a
    // Near-you board must never render both it and the distance pill.
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isPinned: true },
        onPress: vi.fn(),
        onTogglePin: vi.fn(),
        pinLabel: 'Unpin Tension 8x10',
      }),
    );
    const pinDisc = container.querySelector('[data-icon="pin.fill"]')!.parentElement;
    expect(edgeKeys(pinDisc)).toEqual(['bottom', 'right']);

    resetCapture();
    const withDistance = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isPinned: true, distanceMeters: 320 },
        onPress: vi.fn(),
        onTogglePin: vi.fn(),
        pinLabel: 'Unpin Tension 8x10',
      }),
    );
    expect(withDistance.container.querySelector('[data-icon="pin.fill"]')).toBeNull();
    expect(withDistance.container.querySelector('[data-icon="location"]')).not.toBeNull();
  });

  // QA declined #5179 on exactly this: a wide dark pill under two white circles
  // reads as a different kind of control. The pin is a BUTTON, so it wears the
  // button shape — and pinning inverts that disc instead of reshaping it.
  it('wears the same disc as the download and edit buttons', () => {
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, offlineState: 'off' },
        onPress: vi.fn(),
        onDownload: vi.fn(),
        downloadLabel: 'Download Tension 8x10',
        action: 'edit',
        onAction: vi.fn(),
        actionLabel: 'Edit Tension 8x10',
        onTogglePin: vi.fn(),
        pinLabel: 'Pin Tension 8x10',
      }),
    );
    const downloadDisc = container.querySelector('[data-icon="offline.download"]')!.parentElement;
    const editDisc = container.querySelector('[data-icon="edit"]')!.parentElement;
    const pinDisc = container.querySelector('[data-icon="pin"]')!.parentElement;

    expect(discShape(pinDisc)).toEqual(discShape(downloadDisc));
    expect(discShape(pinDisc)).toEqual(discShape(editDisc));
    // Unpinned it is indistinguishable from its two neighbours: same white fill.
    expect(styleOf(pinDisc).backgroundColor).toBe(styleOf(editDisc).backgroundColor);
  });

  it('inverts the disc when pinned rather than changing its shape', () => {
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, offlineState: 'off' },
        onPress: vi.fn(),
        onDownload: vi.fn(),
        downloadLabel: 'Download Tension 8x10',
        onTogglePin: vi.fn(),
        pinLabel: 'Pin Tension 8x10',
      }),
    );
    const restingFill = styleOf(container.querySelector('[data-icon="pin"]')!.parentElement).backgroundColor;

    resetCapture();
    const pinned = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, offlineState: 'off', isPinned: true },
        onPress: vi.fn(),
        onDownload: vi.fn(),
        downloadLabel: 'Download Tension 8x10',
        onTogglePin: vi.fn(),
        pinLabel: 'Unpin Tension 8x10',
      }),
    );
    const pinnedDisc = pinned.container.querySelector('[data-icon="pin.fill"]')!.parentElement;
    const downloadDisc = pinned.container.querySelector('[data-icon="offline.download"]')!.parentElement;

    // The fill flips, the geometry does not.
    expect(styleOf(pinnedDisc).backgroundColor).not.toBe(restingFill);
    expect(discShape(pinnedDisc)).toEqual(discShape(downloadDisc));
  });

  it('toggles from a tap and from the accessibility rotor', () => {
    const onTogglePin = vi.fn();
    const onPress = vi.fn();
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isPinned: false },
        onPress,
        onTogglePin,
        pinLabel: 'Pin Tension 8x10',
      }),
    );

    fireEvent.click(container.querySelector('[data-icon="pin"]')!.parentElement!);
    expect(onTogglePin).toHaveBeenCalledWith({ ...item, isPinned: false });
    // Tapping the pin must not also activate the board underneath it.
    expect(onPress).not.toHaveBeenCalled();

    const dispatch = cardRootProps.last?.onAccessibilityAction as (event: {
      nativeEvent: { actionName: string };
    }) => void;
    dispatch({ nativeEvent: { actionName: 'pin' } });
    expect(onTogglePin).toHaveBeenCalledTimes(2);
  });

  it('publishes the pin as a custom action, since the card is a leaf to VoiceOver', () => {
    render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, isPinned: false },
        onPress: vi.fn(),
        onTogglePin: vi.fn(),
        pinLabel: 'Pin Tension 8x10',
      }),
    );
    const actions = cardRootProps.last?.accessibilityActions as Array<{ name: string; label?: string }>;
    expect(actions.some((action) => action.name === 'pin' && action.label === 'Pin Tension 8x10')).toBe(true);
  });
});

describe('BoardDiscoveryCard accessibility', () => {
  afterEach(resetCapture);

  // Once the owned/followed grouping is gone from this surface the corner glyph
  // is the only owned-vs-followed signal, so the label has to carry it.
  it.each([
    [true, 'Your board'],
    [false, 'Following'],
  ])('announces ownership in the composed label (owner=%s)', (isViewerOwner, expected) => {
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, subtitle: 'Original 12x12', isViewerOwner },
        onPress: vi.fn(),
      }),
    );
    expect(getByTestId('card-root').getAttribute('aria-label')).toBe(`Tension 8x10, Original 12x12, ${expected}`);
  });

  it('announces the active board and omits ownership it cannot resolve', () => {
    const { getByTestId } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, isActive: true }, onPress: vi.fn() }),
    );
    expect(getByTestId('card-root').getAttribute('aria-label')).toBe('Tension 8x10, Active');
  });

  // The outer Pressable absorbs its children on iOS, so both nested glyphs have
  // to be published as labelled custom actions or VoiceOver can never reach them.
  it('publishes the board action and the download glyph as custom actions', () => {
    render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, offlineState: 'off', isViewerOwner: true },
        onPress: vi.fn(),
        onDownload: vi.fn(),
        downloadLabel: 'Make Tension 8x10 available offline',
        action: 'edit',
        onAction: vi.fn(),
        actionLabel: 'Edit Tension 8x10',
      }),
    );
    const actions = (cardRootProps.last?.accessibilityActions ?? []) as { name: string; label?: string }[];
    expect(actions.map((entry) => entry.name)).toEqual(['boardAction', 'download']);
    expect(actions[0]?.label).toBe('Edit Tension 8x10');
    expect(actions[1]?.label).toBe('Make Tension 8x10 available offline');
  });

  // Publishing the array is half the contract; routing it is the other half, and
  // it is the ONLY VoiceOver path to either nested glyph. A mis-wired actionName
  // switch would otherwise ship green.
  it('routes each custom action to its own handler', () => {
    const onPress = vi.fn();
    const onAction = vi.fn();
    const onDownload = vi.fn();
    render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, offlineState: 'off' },
        onPress,
        onDownload,
        downloadLabel: 'Download',
        action: 'edit',
        onAction,
        actionLabel: 'Edit Tension 8x10',
      }),
    );
    const dispatch = cardRootProps.last?.onAccessibilityAction as (event: {
      nativeEvent: { actionName: string };
    }) => void;

    dispatch({ nativeEvent: { actionName: 'boardAction' } });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onDownload).not.toHaveBeenCalled();

    dispatch({ nativeEvent: { actionName: 'download' } });
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledTimes(1);

    dispatch({ nativeEvent: { actionName: 'activate' } });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('leaves activate inert in edit mode, where the card body is not a target', () => {
    const onPress = vi.fn();
    const onAction = vi.fn();
    render(
      createElement(BoardDiscoveryCard, {
        item,
        onPress,
        action: 'delete',
        onAction,
        actionTitle: 'Delete',
        isEditing: true,
      }),
    );
    const dispatch = cardRootProps.last?.onAccessibilityAction as (event: {
      nativeEvent: { actionName: string };
    }) => void;

    dispatch({ nativeEvent: { actionName: 'activate' } });
    expect(onPress).not.toHaveBeenCalled();

    dispatch({ nativeEvent: { actionName: 'boardAction' } });
    expect(onAction).toHaveBeenCalledWith(item);
  });

  it('keeps one accessibilityActions identity across re-renders', () => {
    const props = {
      onPress: vi.fn(),
      action: 'edit' as const,
      onAction: vi.fn(),
      actionLabel: 'Edit Tension 8x10',
    };
    const { rerender } = render(createElement(BoardDiscoveryCard, { item: { ...item }, ...props }));
    // A fresh item object breaks the memo, so the component really does re-render;
    // the actions array must not churn with it.
    rerender(createElement(BoardDiscoveryCard, { item: { ...item }, ...props }));
    expect(cardRootProps.accessibilityActions).toHaveLength(2);
    expect(cardRootProps.accessibilityActions[0]).toBe(cardRootProps.accessibilityActions[1]);
  });
});
