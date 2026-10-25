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
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

const themeState = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));
afterEach(() => {
  themeState.variant = 'liquidGlass';
});

// Minimal RN surface. Pressable exposes its a11y label + hitSlop so the angle
// pill's restored 44pt touch target is inspectable.
type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  hitSlop?: number;
};
vi.mock('react-native', () => ({
  View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) => {
    const flattenedStyle = Object.assign({}, ...[style].flat(10).filter(Boolean));
    return createElement(
      'div',
      {
        'data-testid': testID,
        'data-row-gap': flattenedStyle.gap,
        'data-horizontal-padding': flattenedStyle.paddingHorizontal,
        'data-padding-bottom': flattenedStyle.paddingBottom,
        'data-border-top': flattenedStyle.borderTopWidth,
        'data-border-bottom': flattenedStyle.borderBottomWidth,
        'data-min-height': flattenedStyle.minHeight,
        'data-background': flattenedStyle.backgroundColor,
      },
      children,
    );
  },
  Pressable: ({ children, onPress, accessibilityLabel, hitSlop }: PressMockProps) =>
    createElement(
      'button',
      { onClick: onPress, 'data-label': accessibilityLabel, 'data-hitslop': hitSlop == null ? '' : String(hitSlop) },
      children,
    ),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Icon → expose name + colour so the tick glyph's green (colour-on-glyph, not a
// fill) is assertable. Paths are relative to THIS test file (one level under the
// source in __tests__), so they carry an extra `../`.
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name?: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color }, children),
}));
vi.mock('../../ble/BleLightbulbButton', () => ({
  BleLightbulbButton: ({
    accessibilityLabel,
    accessibilitySelected,
    longPressAccessibilityHint,
    onLongPress,
  }: {
    accessibilityLabel?: string;
    accessibilitySelected?: boolean;
    longPressAccessibilityHint?: string;
    onLongPress?: () => void;
  }) =>
    createElement('div', {
      'data-ble': 'true',
      'data-label': accessibilityLabel,
      'data-selected': accessibilitySelected == null ? undefined : String(accessibilitySelected),
      'data-long-press-hint': longPressAccessibilityHint,
      'data-long-press-enabled': onLongPress ? 'true' : 'false',
    }),
}));
// The holder pip self-reads board presence; stub it so the row renders without
// the presence provider. It renders nothing when the wall is free anyway.
vi.mock('../LightbulbHolderBadge', () => ({
  LightbulbHolderBadge: () => createElement('div', { 'data-lightbulb-holder-badge': 'true' }),
}));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({
  SIZES: { lg: { dim: 48, icon: 28 }, sm: { dim: 44, icon: 22 } },
  ActionButton: ({
    iconName,
    iconColor,
    checked,
    accessibilityLabel,
    accessibilityValueText,
    testID,
    size,
    onPress,
  }: {
    iconName?: string;
    iconColor?: string;
    checked?: boolean;
    accessibilityLabel?: string;
    accessibilityValueText?: string;
    testID?: string;
    size?: string;
    onPress?: () => void;
  }) =>
    createElement('div', {
      onClick: onPress,
      'data-action': iconName,
      'data-testid': testID,
      'data-size': size,
      'data-icon-color': iconColor,
      'data-checked': checked == null ? undefined : String(checked),
      'data-label': accessibilityLabel,
      'data-value': accessibilityValueText,
    }),
  drawerActionBarStyles: {
    container: { borderTopWidth: 1 },
    rowPrimary: {},
    primarySlot: {},
    // A gap only the second row has, so a test can tell whether it is drawn.
    rowSecondary: { gap: 8 },
    spacer: {},
    actionButton: {},
    actionButtonPressed: {},
  },
}));
// The latch controls' own content is covered by their own test; stubbed here
// (they pull reanimated) so this file stays a pure prop-contract test of the bar
// itself: which control renders where, and which handler each one is handed.
vi.mock('../PlayDrawerCommitBar', () => ({
  PlayDrawerCommitBar: ({
    wallClimbName,
    wallClimbUuid,
    onKeepTheirs,
    onConfirm,
  }: {
    wallClimbName: string | null;
    wallClimbUuid: string | null;
    onKeepTheirs: () => void;
    onConfirm: () => void;
  }) =>
    createElement(
      'div',
      {
        'data-commit-bar': 'true',
        'data-wall-climb': wallClimbName ?? '',
        'data-wall-climb-uuid': wallClimbUuid ?? '',
      },
      createElement('button', { 'data-keep-theirs': 'true', onClick: onKeepTheirs }),
      createElement('button', { 'data-confirm': 'true', onClick: onConfirm }),
    ),
  PutOnWallButton: ({ commitLabel, onPress }: { commitLabel: string; onPress: () => void }) =>
    createElement('button', { 'data-put-on-wall': 'true', 'data-commit-label': commitLabel, onClick: onPress }),
}));
// The connect-step pill has its own test; here only where it goes, and that it
// is handed the bulb's own tap and pending state.
vi.mock('../FirstConnectPill', () => ({
  FirstConnectPill: ({ pending, onPress }: { pending: boolean; onPress: () => void }) =>
    createElement('button', { 'data-connect-pill': 'true', 'data-pending': String(pending), onClick: onPress }),
}));
vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#6D28D9', success: '#047857' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    variant: themeState.variant,
    brandColors: { primary: '#6D28D9', success: '#047857', error: 'brandError' },
    systemColors: {
      label: 'label',
      fill: 'rgba(109, 40, 217, 0.14)',
      secondaryLabel: 'secondaryLabel',
      separator: 'separator',
    },
    actionColors: { favoriteSelected: 'favoriteSelected' },
  }),
}));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#FFFFFF' },
}));
vi.mock('../../../theme/layout', () => ({ glassSize: { mini: 32 } }));
const haptics = vi.hoisted(() => ({ hapticMedium: vi.fn(), hapticSelection: vi.fn() }));
vi.mock('../../../lib/haptics', () => haptics);

import { PlayDrawerActionBar } from '../PlayDrawerActionBar';
import { useWorkoutOutcomeHold } from '../use-workout-outcome-hold';
import { WALL_MOVED_GRACE_MS } from '../workout-outcome';

const baseProps = {
  canSwipePrevious: true,
  canSwipeNext: true,
  isMirrored: false,
  supportsMirroring: true,
  isFavorited: false,
  remainingQueueCount: 3,
  lightbulbActive: false,
  lightbulbConnected: false,
  ascentCount: 2,
  currentAngle: 40,
  onPrevClick: vi.fn(),
  onNextClick: vi.fn(),
  onMirror: vi.fn(),
  onToggleFavorite: vi.fn(),
  onLightbulb: vi.fn(),
  onOpenQueue: vi.fn(),
  onShare: vi.fn(),
  onTickPress: vi.fn(),
  onTickLongPress: vi.fn(),
  onOpenAngleSelector: vi.fn(),
};

/** The `data-action` iconName each ActionButton renders under (see the mock). */
const ACTION_ICONS = {
  mirror: 'mirror',
  previous: 'skip.previous',
  next: 'skip.next',
  favorite: 'favorite',
  favoriteFilled: 'favorite.fill',
  queue: 'queue',
} as const;

function actions(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-action]')].map((node) => node.getAttribute('data-action') ?? '');
}

/** Every labelled control, in the order a screen reader meets them. */
function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-label]')].map((node) => node.getAttribute('data-label') ?? '');
}

const QUEUE_LABEL = 'playView.actionBar.queueCountAria';
const FAVORITE_LABEL = 'playView.actionBar.addFavoriteAria';
const ANGLE_LABEL = 'mobile.angleSelector.title';
const SHARE_LABEL = 'mobile.climbRow.share';

describe('PlayDrawerActionBar', () => {
  // ⋯ moved to the drawer's top row, and section choices live there and in
  // Settings → Climb view, so neither ⋯ nor the eye belongs to the bar any more.
  it('draws neither ⋯ nor the section eye', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));

    expect(actions(container)).not.toContain('more');
    expect(actions(container)).not.toContain('visibility');
    expect(container.querySelector('[data-label="playView.actionBar.climbActionsAria"]')).toBeNull();
  });

  // Where a board can't mirror, the queue takes the first slot: it is the list
  // ⏮ and ⏭ walk. The heart leads the second row and share closes it.
  it('puts the queue in the first slot and the heart first in the second row on a board without mirror', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, supportsMirroring: false }));
    const order = labels(container);

    expect(order[0]).toBe(QUEUE_LABEL);
    expect(container.querySelector(`[data-label="${QUEUE_LABEL}"]`)?.getAttribute('data-size')).toBe('lg');
    expect(actions(container)).not.toContain(ACTION_ICONS.mirror);
    expect(order.slice(order.indexOf(FAVORITE_LABEL))).toEqual([FAVORITE_LABEL, ANGLE_LABEL, SHARE_LABEL]);
    expect(order.filter((label) => label === QUEUE_LABEL)).toHaveLength(1);
  });

  // Mirror keeps the first slot because it changes what's lit; the queue stays
  // at the right of the second row, where it has always been.
  it('keeps mirror first and the queue last in the second row on a mirror board', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    const order = labels(container);

    expect(order[0]).toBe('playView.actionBar.mirrorAria');
    expect(order.slice(order.indexOf(FAVORITE_LABEL))).toEqual([FAVORITE_LABEL, ANGLE_LABEL, SHARE_LABEL, QUEUE_LABEL]);
    expect(container.querySelector(`[data-label="${QUEUE_LABEL}"]`)?.getAttribute('data-size')).toBe('sm');
  });

  it('renders the tick as a green glyph (colour on the icon, not a solid fill)', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    const tick = container.querySelector('[data-icon="tick.outline"]') as HTMLElement;

    expect(tick).toBeTruthy();
    expect(tick.getAttribute('data-color')).toBe('#047857');
    // The old solid-white-on-green tick is gone — no white tick glyph remains.
    expect(container.querySelector('[data-icon="tick.outline"][data-color="#FFFFFF"]')).toBeNull();
  });

  it.each(['liquidGlass', 'material'] as const)(
    'keeps share, angle, and favourite colours appropriate to %s',
    (variant) => {
      themeState.variant = variant;
      const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, isFavorited: true }));

      expect(container.querySelector('[data-icon="share"]')?.getAttribute('data-color')).toBe(
        variant === 'liquidGlass' ? 'label' : 'secondaryLabel',
      );
      const anglePill = container.querySelector('[data-label="mobile.angleSelector.title"]') as HTMLElement;
      expect(anglePill.querySelector('span')?.getAttribute('data-color')).toBe('secondaryLabel');
      expect(
        container.querySelector(`[data-action="${ACTION_ICONS.favoriteFilled}"]`)?.getAttribute('data-icon-color'),
      ).toBe('favoriteSelected');
    },
  );

  it('suppresses the lightbulb holder pip when the header pill owns the driver face', () => {
    // Default: the pip shows on the lightbulb.
    const withPip = render(createElement(PlayDrawerActionBar, baseProps));
    expect(withPip.container.querySelector('[data-lightbulb-holder-badge="true"]')).toBeTruthy();

    // Pill showing the avatar → showHolderBadge false → no second face in the drawer.
    const noPip = render(createElement(PlayDrawerActionBar, { ...baseProps, showHolderBadge: false }));
    expect(noPip.container.querySelector('[data-lightbulb-holder-badge="true"]')).toBeNull();
  });

  it('omits the Bluetooth action when the host has no Bluetooth provider', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, showLightbulb: false }));

    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(container.querySelector('[data-lightbulb-holder-badge="true"]')).toBeNull();
  });

  // #5960: the drawer passes no onShare for a draft, which only its setter can open.
  it('draws the share button only when there is something to share', () => {
    const withShare = render(createElement(PlayDrawerActionBar, baseProps));
    expect(withShare.container.querySelector('[data-label="mobile.climbRow.share"]')).not.toBeNull();

    const draft = render(createElement(PlayDrawerActionBar, { ...baseProps, onShare: undefined }));
    expect(draft.container.querySelector('[data-label="mobile.climbRow.share"]')).toBeNull();
  });

  it('keeps the 32pt angle pill tappable at the 44pt floor via hit-slop', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    const anglePill = container.querySelector('[data-label="mobile.angleSelector.title"]') as HTMLElement;

    expect(anglePill).toBeTruthy();
    expect(anglePill.textContent).toContain('40°');
    expect(Number(anglePill.getAttribute('data-hitslop'))).toBeGreaterThanOrEqual(6);
  });

  it('derives the lightbulb label + selected state from local BLE (lightbulbConnected), not the lit visual', () => {
    // Peer lit the wall (lightbulbActive true) but this phone is NOT connected:
    // the bulb is filled, yet tapping connects — so the a11y label/selected must
    // read "connect", not "turn off"/selected.
    const peerLit = render(
      createElement(PlayDrawerActionBar, { ...baseProps, lightbulbActive: true, lightbulbConnected: false }),
    );
    const peerBulb = peerLit.container.querySelector('[data-ble="true"]') as HTMLElement;
    expect(peerBulb.getAttribute('data-label')).toBe('ble.connectBoard');
    expect(peerBulb.getAttribute('data-selected')).toBe('false');

    // This phone connected → tapping disconnects → "turn off" + selected.
    const localConnected = render(
      createElement(PlayDrawerActionBar, { ...baseProps, lightbulbActive: true, lightbulbConnected: true }),
    );
    const localBulb = localConnected.container.querySelector('[data-ble="true"]') as HTMLElement;
    expect(localBulb.getAttribute('data-label')).toBe('ble.turnOff');
    expect(localBulb.getAttribute('data-selected')).toBe('true');
  });

  it('passes party wall-control labels through to the lightbulb', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        lightbulbActive: true,
        lightbulbAccessibilityLabel: 'Release wall control',
        lightbulbLongPressAccessibilityHint: 'Hold for Bluetooth controls',
      }),
    );
    const lightbulb = container.querySelector('[data-ble="true"]') as HTMLElement;

    expect(lightbulb.getAttribute('data-label')).toBe('Release wall control');
    expect(lightbulb.getAttribute('data-long-press-hint')).toBe('Hold for Bluetooth controls');
  });

  it('gates lightbulb long-press controls separately from the active state', () => {
    const { container, rerender } = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        lightbulbActive: true,
        lightbulbLongPressEnabled: false,
        lightbulbAccessibilityLabel: 'Release wall control',
      }),
    );
    const inactiveLongPressBulb = container.querySelector('[data-ble="true"]') as HTMLElement;

    expect(inactiveLongPressBulb.getAttribute('data-long-press-enabled')).toBe('false');
    expect(inactiveLongPressBulb.getAttribute('data-long-press-hint')).toBeNull();

    rerender(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        lightbulbActive: false,
        lightbulbLongPressEnabled: true,
        lightbulbAccessibilityLabel: 'Take wall control',
        onLightbulbLongPress: vi.fn(),
      }),
    );
    const activeLongPressBulb = container.querySelector('[data-ble="true"]') as HTMLElement;

    expect(activeLongPressBulb.getAttribute('data-long-press-enabled')).toBe('true');
    expect(activeLongPressBulb.getAttribute('data-long-press-hint')).toBe('ble.holdForControls');
  });
});

describe("PlayDrawerActionBar (the climber's buttons)", () => {
  const order = ['mirror', 'favorite', 'angle', 'share', 'queue'] as const;
  const visibleAll = { mirror: true, favorite: true, angle: true, share: true, queue: true };
  const secondRows = (container: HTMLElement) => container.querySelectorAll('[data-row-gap="8"]');

  it('leaves both ⏮ ⏭ slots empty with Previous and next off, keeping the tick in the middle slot', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, previousNext: false }));
    expect(actions(container)).not.toContain(ACTION_ICONS.previous);
    expect(actions(container)).not.toContain(ACTION_ICONS.next);
    // Five slots either way: mirror, empty, tick, empty, bulb.
    const firstRow = container.querySelector('[data-icon="tick.outline"]')?.closest('div')?.parentElement;
    expect(firstRow?.children).toHaveLength(5);
  });

  it('drops the second row when every small button is off, and the first row takes its bottom padding', () => {
    const allOff = { order, visible: { mirror: false, favorite: false, angle: false, share: false, queue: false } };
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, buttons: allOff }));
    expect(secondRows(container)).toHaveLength(0);
    expect(container.querySelector('[data-padding-bottom="12"]')).not.toBeNull();
    expect(labels(container)).not.toContain(FAVORITE_LABEL);
    expect(labels(container)).not.toContain(SHARE_LABEL);
  });

  it('holds an empty 64pt second row for a draft when Share is the only small button on', () => {
    const shareOnly = { order, visible: { mirror: false, favorite: false, angle: false, share: true, queue: true } };
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        supportsMirroring: false,
        buttons: shareOnly,
        onShare: undefined,
      }),
    );
    const secondRow = secondRows(container)[0];
    expect(secondRow).toBeDefined();
    expect(secondRow?.getAttribute('data-min-height')).toBe('64');
    expect(labels(container)).not.toContain(SHARE_LABEL);
  });

  it('brings the second row back for Put on the wall and for the busy-wall question', () => {
    const allOff = { order, visible: { mirror: false, favorite: false, angle: false, share: false, queue: false } };
    const latchProps = { ...baseProps, buttons: allOff, onKeepTheirs: vi.fn(), onCommit: vi.fn() };

    const browsing = render(createElement(PlayDrawerActionBar, { ...latchProps, commitButton: 'putOnWall' as const }));
    expect(secondRows(browsing.container)).toHaveLength(1);
    expect(browsing.container.querySelector('[data-put-on-wall]')).not.toBeNull();
    browsing.unmount();

    const confirming = render(createElement(PlayDrawerActionBar, { ...latchProps, commitButton: 'confirm' as const }));
    expect(secondRows(confirming.container)).toHaveLength(1);
    expect(confirming.container.querySelector('[data-commit-bar]')).not.toBeNull();
  });

  it('draws a small mirror toggle when the queue comes first on a mirror board', () => {
    const onMirror = vi.fn();
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        onMirror,
        buttons: { order: ['queue', 'mirror', 'favorite', 'angle', 'share'], visible: visibleAll },
      }),
    );
    expect(container.querySelector(`[data-label="${QUEUE_LABEL}"]`)?.getAttribute('data-size')).toBe('lg');
    const mirror = container.querySelector('[data-label="playView.actionBar.mirrorAria"]') as HTMLElement;
    expect(mirror.getAttribute('data-size')).toBe('sm');
    fireEvent.click(mirror);
    expect(onMirror).toHaveBeenCalledTimes(1);
    expect(haptics.hapticSelection).toHaveBeenCalled();
  });

  it('moves the hairline to the bottom edge above the board', () => {
    const below = render(createElement(PlayDrawerActionBar, baseProps));
    const belowBar = below.getByTestId('play-drawer-action-bar');
    expect(belowBar.getAttribute('data-border-top')).toBe('1');
    expect(belowBar.getAttribute('data-border-bottom')).toBeNull();
    below.unmount();

    const above = render(createElement(PlayDrawerActionBar, { ...baseProps, edge: 'bottom' }));
    const aboveBar = above.getByTestId('play-drawer-action-bar');
    expect(aboveBar.getAttribute('data-border-top')).toBeNull();
    expect(aboveBar.getAttribute('data-border-bottom')).toBe(String(1));
  });

  it("ignores the climber's buttons for a signed-out reader", () => {
    const allOff = { order, visible: { mirror: false, favorite: false, angle: false, share: false, queue: false } };
    const { container } = render(
      createElement(PlayDrawerActionBar, { ...baseProps, viewer: 'anonymous', buttons: allOff, previousNext: false }),
    );
    expect(actions(container)).toEqual(
      expect.arrayContaining([ACTION_ICONS.mirror, ACTION_ICONS.previous, ACTION_ICONS.next]),
    );
    expect(labels(container)).toContain(SHARE_LABEL);
  });
});

// While browsing, Put on the wall sits in the middle of the usual row with one
// button kept on each side (the rest step into ⋯); only the busy-wall question
// takes the whole row. Neither is
// ever a new band: the drawer's height budget is why both live in a row that
// already exists.
describe('PlayDrawerActionBar (browse latch controls)', () => {
  const browseProps = {
    ...baseProps,
    commitButton: 'putOnWall' as const,
    commitLabel: 'putOnWall' as const,
    onKeepTheirs: vi.fn(),
    onCommit: vi.fn(),
  };
  const confirmProps = { ...browseProps, commitButton: 'confirm' as const, wallClimbName: 'Their Project' };

  /** The second row's controls in reading order, Put on the wall included. */
  const secondRowOrder = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-label], [data-put-on-wall]')]
      .map((node) => (node.hasAttribute('data-put-on-wall') ? 'putOnWall' : (node.getAttribute('data-label') ?? '')))
      .filter(
        (entry) => entry === 'putOnWall' || [FAVORITE_LABEL, ANGLE_LABEL, SHARE_LABEL, QUEUE_LABEL].includes(entry),
      );

  it('puts Put on the wall in the middle, the heart and the queue either side, angle and share in ⋯', () => {
    const { container } = render(createElement(PlayDrawerActionBar, browseProps));

    expect(container.querySelector('[data-commit-bar]')).toBeNull();
    expect(secondRowOrder(container)).toEqual([FAVORITE_LABEL, 'putOnWall', QUEUE_LABEL]);
    expect(container.querySelector(`[data-label="${ANGLE_LABEL}"]`)).toBeNull();
    expect(container.querySelector('[data-icon="share"]')).toBeNull();
    expect(container.querySelector('[data-icon="tick.outline"]')).toBeTruthy();
  });

  it('keeps the queue in the first slot on a board without mirror, the heart and share either side', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...browseProps, supportsMirroring: false }));

    expect(labels(container)[0]).toBe(QUEUE_LABEL);
    expect(secondRowOrder(container)).toEqual([QUEUE_LABEL, FAVORITE_LABEL, 'putOnWall', SHARE_LABEL]);
    expect(container.querySelector(`[data-label="${ANGLE_LABEL}"]`)).toBeNull();
  });

  it('runs the commit, and nothing else, from Put on the wall', () => {
    const onCommit = vi.fn();
    const onKeepTheirs = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...browseProps, onCommit, onKeepTheirs }));

    (container.querySelector('[data-put-on-wall]') as HTMLElement).click();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onKeepTheirs).not.toHaveBeenCalled();
  });

  it('passes the context-sensitive commit label through', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...browseProps, commitLabel: 'setActive' }));

    expect(container.querySelector('[data-put-on-wall]')?.getAttribute('data-commit-label')).toBe('setActive');
  });

  // Put on the wall sits between two spacers; a key per item name would collide.
  it('keys the two gaps around Put on the wall apart', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(createElement(PlayDrawerActionBar, browseProps));
      const keyWarnings = consoleError.mock.calls.filter((call) => String(call[0]).includes('same key'));
      expect(keyWarnings).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('swaps the whole row for the busy-wall question, handing it the lit climb', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, { ...confirmProps, wallClimbUuid: 'climb-on-the-wall' }),
    );
    const question = container.querySelector('[data-commit-bar="true"]');

    expect(question?.getAttribute('data-wall-climb')).toBe('Their Project');
    // Its uuid too, so the question only names whoever put THAT climb up.
    expect(question?.getAttribute('data-wall-climb-uuid')).toBe('climb-on-the-wall');
    expect(container.querySelector('[data-put-on-wall]')).toBeNull();
    // The row's own buttons go for the duration; the host's ⋯ picks them up.
    expect(container.querySelector(`[data-label="${ANGLE_LABEL}"]`)).toBeNull();
    expect(actions(container)).not.toContain(ACTION_ICONS.queue);
    expect(actions(container)).not.toContain(ACTION_ICONS.favorite);
    expect(container.querySelector('[data-icon="share"]')).toBeNull();
    // The primary row still acts on the displayed climb.
    expect(container.querySelector('[data-icon="tick.outline"]')).toBeTruthy();
  });

  it('routes Put mine up to the commit and Keep theirs to its own handler', () => {
    const onCommit = vi.fn();
    const onKeepTheirs = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...confirmProps, onCommit, onKeepTheirs }));

    (container.querySelector('[data-keep-theirs]') as HTMLElement).click();
    expect(onKeepTheirs).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    (container.querySelector('[data-confirm]') as HTMLElement).click();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  // Up in the first slot the queue survives the swap: browsing never takes away
  // the list the climber is browsing.
  it('keeps the queue in the first slot under the question on a board without mirror', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...confirmProps, supportsMirroring: false }));

    expect(container.querySelector('[data-commit-bar="true"]')).toBeTruthy();
    expect(labels(container)[0]).toBe(QUEUE_LABEL);
  });

  it('paints no tint on the row in either latch state', () => {
    for (const props of [browseProps, confirmProps]) {
      const { container, unmount } = render(createElement(PlayDrawerActionBar, props));
      const secondRow = container.querySelector('[data-row-gap="8"]');
      expect(secondRow).not.toBeNull();
      expect(secondRow?.getAttribute('data-background')).toBeNull();
      unmount();
    }
  });

  it('draws neither latch control while the latch is down', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...browseProps, commitButton: null }));

    expect(container.querySelector('[data-commit-bar="true"]')).toBeNull();
    expect(container.querySelector('[data-put-on-wall]')).toBeNull();
    expect(container.querySelector(`[data-label="${ANGLE_LABEL}"]`)).toBeTruthy();
  });

  it('stands a control down when the host did not hand it the handler it needs', () => {
    // No commit handler: neither control can do anything, so neither renders.
    const noCommit = render(createElement(PlayDrawerActionBar, { ...browseProps, onCommit: undefined }));
    expect(noCommit.container.querySelector('[data-put-on-wall]')).toBeNull();
    noCommit.unmount();

    // The question without Keep theirs would be a one-way door: the usual row stays.
    const noKeep = render(createElement(PlayDrawerActionBar, { ...confirmProps, onKeepTheirs: undefined }));
    expect(noKeep.container.querySelector('[data-commit-bar="true"]')).toBeNull();
    expect(noKeep.container.querySelector(`[data-label="${ANGLE_LABEL}"]`)).toBeTruthy();
  });

  it.each(['putOnWall', 'confirm'] as const)('never gives a signed-out reader %s', (commitButton) => {
    // The anonymous drawer is ALWAYS a preview, so a resolver bug that let a
    // latch control through would put a live `setCurrentClimb` button — the
    // queue write and BLE re-arm every other anonymous rule removes — on every
    // read-only open. The suppression is asserted HERE, not only in the
    // resolver, because the bar is the last gate before it renders.
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...browseProps,
        commitButton,
        viewer: 'anonymous' as const,
        onSignInPress: vi.fn(),
      }),
    );

    expect(container.querySelector('[data-commit-bar="true"]')).toBeNull();
    expect(container.querySelector('[data-put-on-wall]')).toBeNull();
  });

  it.each(['putOnWall', 'confirm', null] as const)('has no heatmap flame with %s', (commitButton) => {
    // The heatmap lives where holds get picked (hold filter, create climb), not
    // on a single climb.
    const { container } = render(createElement(PlayDrawerActionBar, { ...browseProps, commitButton }));
    expect(container.querySelector('[data-action="flame"], [data-action="flame.fill"]')).toBeNull();
  });
});

// The signed-out reader on app.boardsesh.com's read-only climb URL. Every
// affordance is asserted individually rather than as one "renders no write
// buttons" sweep: flipping a single gate is a distinct product regression (a
// heart that 401s; a missing tick that turns the surface into a dead end), and a
// blanket assertion could not tell them apart.
describe('PlayDrawerActionBar (anonymous viewer)', () => {
  const anonymousProps = { ...baseProps, viewer: 'anonymous' as const, onSignInPress: vi.fn() };

  it('removes the queue, favourite and lightbulb affordances', () => {
    const { container } = render(createElement(PlayDrawerActionBar, anonymousProps));
    const rendered = actions(container);

    expect(rendered).not.toContain(ACTION_ICONS.queue);
    expect(rendered).not.toContain(ACTION_ICONS.favorite);
    expect(rendered).not.toContain(ACTION_ICONS.favoriteFilled);
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(container.querySelector('[data-lightbulb-holder-badge="true"]')).toBeNull();
  });

  // On a board with no mirror support the queue normally takes the first primary
  // slot; anonymously that has to go too, or the removal above is only half true.
  // The slot stays empty and the row keeps its spacing.
  it('leaves the first slot empty on a board without mirror', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...anonymousProps, supportsMirroring: false }));

    expect(actions(container)).not.toContain(ACTION_ICONS.queue);
    expect(actions(container)).not.toContain(ACTION_ICONS.favorite);
    expect(labels(container)[0]).toBe('playView.actionBar.previousAria');
  });

  it('keeps the reads: mirror, prev/next, share and the angle pill', () => {
    const { container } = render(createElement(PlayDrawerActionBar, anonymousProps));
    const rendered = actions(container);

    expect(rendered).toContain(ACTION_ICONS.mirror);
    expect(rendered).toContain(ACTION_ICONS.previous);
    expect(rendered).toContain(ACTION_ICONS.next);
    expect(container.querySelector('[data-icon="share"]')).toBeTruthy();
    expect(container.querySelector('[data-label="mobile.angleSelector.title"]')).toBeTruthy();
  });

  // The tick is the ONLY prompt in the anonymous bar. Hiding it would leave the
  // visitor no way in; wiring it to onTickPress would open a tick sheet that
  // cannot save.
  it('keeps the tick button and routes it to the sign-in handler, not the tick sheet', () => {
    const onSignInPress = vi.fn();
    const onTickPress = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...anonymousProps, onSignInPress, onTickPress }));
    const tick = container.querySelector('[data-label="mobile.anonymous.tickAria"]') as HTMLElement;

    expect(tick).toBeTruthy();
    expect(container.querySelector('[data-icon="tick.outline"]')).toBeTruthy();
    tick.click();
    expect(onSignInPress).toHaveBeenCalledTimes(1);
    expect(onTickPress).not.toHaveBeenCalled();
  });

  // `ascentCount` is the viewer's own send count. Anonymously it is somebody
  // else's number, so the badge must not render.
  it('drops the ascent badge, which counts a logbook the reader does not have', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...anonymousProps, ascentCount: 7 }));

    expect(container.textContent).not.toContain('7');
  });

  // The member bar is the invariant half: nothing above may leak into it.
  it('leaves the member bar untouched', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    const rendered = actions(container);

    expect(rendered).toContain(ACTION_ICONS.queue);
    expect(rendered).toContain(ACTION_ICONS.favorite);
    expect(container.querySelector('[data-ble="true"]')).toBeTruthy();
    expect(container.querySelector('[data-label="playView.tickFab.logAscentAria"]')).toBeTruthy();
  });
});

// #5654, PR 7: the connect-step treatment turns the bulb into a labelled pill at
// the right end of the second row. Share (and the queue, on a mirror board) goes
// to the host's ⋯; the tick keeps its slot.
describe('PlayDrawerActionBar (connect-step pill)', () => {
  const pillProps = { ...baseProps, connectPill: true };

  it('moves the bulb into the second row as the pill, and share and queue out of it on a mirror board', () => {
    const onLightbulb = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...pillProps, onLightbulb }));
    const pill = container.querySelector('[data-connect-pill="true"]') as HTMLElement;

    expect(pill).toBeTruthy();
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(actions(container)).not.toContain(ACTION_ICONS.queue);
    expect(container.querySelector('[data-icon="share"]')).toBeNull();
    pill.click();
    expect(onLightbulb).toHaveBeenCalledTimes(1);
  });

  // Without mirror the queue already sits in the first slot, so only share goes.
  it('keeps the queue in the first slot on a board without mirror', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...pillProps, supportsMirroring: false }));

    expect(container.querySelector('[data-connect-pill="true"]')).toBeTruthy();
    expect(labels(container)[0]).toBe(QUEUE_LABEL);
    expect(container.querySelector('[data-icon="share"]')).toBeNull();
  });

  it('gives the pill its own tap when the host passes one, so its connects log as the pill', () => {
    const onLightbulb = vi.fn();
    const onConnectPill = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...pillProps, onLightbulb, onConnectPill }));

    (container.querySelector('[data-connect-pill="true"]') as HTMLElement).click();

    expect(onConnectPill).toHaveBeenCalledTimes(1);
    expect(onLightbulb).not.toHaveBeenCalled();
  });

  it('keeps the tick, the heart and the angle', () => {
    const { container } = render(createElement(PlayDrawerActionBar, pillProps));
    const rendered = actions(container);

    expect(container.querySelector('[data-icon="tick.outline"]')).toBeTruthy();
    expect(rendered).toContain(ACTION_ICONS.favorite);
    expect(container.querySelector('[data-label="mobile.angleSelector.title"]')).toBeTruthy();
  });

  it('shows a connect in flight on the pill', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...pillProps, lightbulbPending: true }));

    expect(container.querySelector('[data-connect-pill="true"]')?.getAttribute('data-pending')).toBe('true');
  });

  it('gives way to Put on the wall while the latch is up, share back in its place', () => {
    const latchProps = {
      ...pillProps,
      commitButton: 'putOnWall' as const,
      onKeepTheirs: vi.fn(),
      onCommit: vi.fn(),
    };
    // Without mirror, share is the last button on the right, so it comes back.
    const { container } = render(createElement(PlayDrawerActionBar, { ...latchProps, supportsMirroring: false }));

    expect(container.querySelector('[data-connect-pill="true"]')).toBeNull();
    expect(container.querySelector('[data-put-on-wall]')).toBeTruthy();
    expect(container.querySelector('[data-icon="share"]')).toBeTruthy();
    // The bulb is back in its slot rather than lost.
    expect(container.querySelector('[data-ble="true"]')).toBeTruthy();

    // On a mirror board the queue holds the right-hand place and share stays in ⋯.
    const mirror = render(createElement(PlayDrawerActionBar, latchProps));
    expect(mirror.container.querySelector('[data-connect-pill="true"]')).toBeNull();
    expect(actions(mirror.container)).toContain(ACTION_ICONS.queue);
    expect(mirror.container.querySelector('[data-icon="share"]')).toBeNull();
    expect(mirror.container.querySelector('[data-ble="true"]')).toBeTruthy();
  });

  it('gives way to the busy-wall question too', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...pillProps,
        commitButton: 'confirm' as const,
        onKeepTheirs: vi.fn(),
        onCommit: vi.fn(),
      }),
    );

    expect(container.querySelector('[data-connect-pill="true"]')).toBeNull();
    expect(container.querySelector('[data-commit-bar="true"]')).toBeTruthy();
    expect(container.querySelector('[data-ble="true"]')).toBeTruthy();
  });

  it('never shows without a Bluetooth provider, or to a signed-out reader', () => {
    const noBluetooth = render(createElement(PlayDrawerActionBar, { ...pillProps, showLightbulb: false }));
    expect(noBluetooth.container.querySelector('[data-connect-pill="true"]')).toBeNull();

    const anonymous = render(
      createElement(PlayDrawerActionBar, { ...pillProps, viewer: 'anonymous' as const, onSignInPress: vi.fn() }),
    );
    expect(anonymous.container.querySelector('[data-connect-pill="true"]')).toBeNull();
  });

  it('leaves the bar as it was without the pill', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));

    expect(container.querySelector('[data-connect-pill="true"]')).toBeNull();
    expect(container.querySelector('[data-ble="true"]')).toBeTruthy();
    expect(actions(container)).toContain(ACTION_ICONS.queue);
    expect(container.querySelector('[data-icon="share"]')).toBeTruthy();
  });
});

// HIG "Playing haptics": plain buttons give no haptic, toggles a selection tick.
describe('PlayDrawerActionBar haptics', () => {
  function press(container: HTMLElement, selector: string) {
    const node = container.querySelector(selector);
    if (!node) throw new Error(`nothing matches ${selector}`);
    fireEvent.click(node);
  }

  it('gives prev, next, share, angle and the tick no haptic, and still runs them', () => {
    haptics.hapticMedium.mockClear();
    haptics.hapticSelection.mockClear();
    const onPrevClick = vi.fn();
    const onNextClick = vi.fn();
    const onShare = vi.fn();
    const onOpenAngleSelector = vi.fn();
    const onTickPress = vi.fn();
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        onPrevClick,
        onNextClick,
        onShare,
        onOpenAngleSelector,
        onTickPress,
      }),
    );
    press(container, `[data-action="${ACTION_ICONS.previous}"]`);
    press(container, `[data-action="${ACTION_ICONS.next}"]`);
    press(container, '[data-label="mobile.climbRow.share"]');
    press(container, '[data-label="mobile.angleSelector.title"]');
    press(container, '[data-label="playView.tickFab.logAscentAria"]');

    expect(onPrevClick).toHaveBeenCalledTimes(1);
    expect(onNextClick).toHaveBeenCalledTimes(1);
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onOpenAngleSelector).toHaveBeenCalledTimes(1);
    expect(onTickPress).toHaveBeenCalledTimes(1);
    expect(haptics.hapticMedium).not.toHaveBeenCalled();
    expect(haptics.hapticSelection).not.toHaveBeenCalled();
  });

  it('ticks a selection for the mirror and favourite toggles', () => {
    haptics.hapticMedium.mockClear();
    haptics.hapticSelection.mockClear();
    const onMirror = vi.fn();
    const onToggleFavorite = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, onMirror, onToggleFavorite }));
    press(container, `[data-action="${ACTION_ICONS.mirror}"]`);
    press(container, `[data-action="${ACTION_ICONS.favorite}"]`);

    expect(onMirror).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(haptics.hapticSelection).toHaveBeenCalledTimes(2);
    expect(haptics.hapticMedium).not.toHaveBeenCalled();
  });
});

// The row's own taps are covered by use-workout-one-tap.test.tsx; here only where
// it goes, what it pushes out, and that it is handed the climb and the tick
// sheet opener.
const workoutOutcomeRow = vi.hoisted(() => ({ onFell: vi.fn() }));
vi.mock('../WorkoutOutcomeRow', () => ({
  WorkoutOutcomeRow: ({
    target,
    wallLeftAtMs,
    onOpenLogSheet,
  }: {
    target: { queueItemUuid: string };
    wallLeftAtMs?: number | null;
    onOpenLogSheet: () => void;
  }) =>
    createElement(
      'button',
      {
        'data-workout-outcome': target.queueItemUuid,
        'data-wall-left-at': wallLeftAtMs == null ? '' : String(wallLeftAtMs),
        onClick: onOpenLogSheet,
      },
      // Where the real row's Fell sits: the left of the second row.
      createElement('span', {
        'data-workout-outcome-fell': 'true',
        onClick: (event: Event) => {
          event.stopPropagation();
          workoutOutcomeRow.onFell(target.queueItemUuid);
        },
      }),
    ),
}));

describe('PlayDrawerActionBar (timed workout block)', () => {
  const workoutOutcome = {
    climb: { uuid: 'climb-1' } as unknown as Climb,
    queueItemUuid: 'item-1',
    sessionId: 'session-1',
    boardName: 'tension',
    layoutId: 9,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    isMirror: false,
  };
  const workoutProps = { ...baseProps, workoutOutcome };

  it('gives the whole second row to Fell / Sent for the climb up', () => {
    const { container } = render(createElement(PlayDrawerActionBar, workoutProps));

    expect(container.querySelector('[data-workout-outcome]')?.getAttribute('data-workout-outcome')).toBe('item-1');
    expect(container.querySelector(`[data-label="${FAVORITE_LABEL}"]`)).toBeNull();
    expect(container.querySelector(`[data-label="${ANGLE_LABEL}"]`)).toBeNull();
    expect(container.querySelector(`[data-label="${SHARE_LABEL}"]`)).toBeNull();
    // Mirror keeps the first slot, Log the middle; the queue steps into ⋯.
    expect(actions(container)).toEqual([ACTION_ICONS.mirror, ACTION_ICONS.previous, ACTION_ICONS.next]);
    expect(container.querySelector(`[data-label="${QUEUE_LABEL}"]`)).toBeNull();
    expect(container.querySelector('[data-icon="tick.outline"]')).toBeTruthy();
  });

  it('keeps the queue in the first slot on a board without mirror', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...workoutProps, supportsMirroring: false }));

    expect(labels(container)[0]).toBe(QUEUE_LABEL);
    expect(container.querySelector('[data-workout-outcome]')).toBeTruthy();
  });

  it('hands the row the tick sheet opener, for a spray climb that needs a grade', () => {
    const onTickPress = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...workoutProps, onTickPress }));

    fireEvent.click(container.querySelector('[data-workout-outcome]') as HTMLElement);

    expect(onTickPress).toHaveBeenCalledTimes(1);
  });

  it('brings the row back with every small button switched off', () => {
    const allOff = {
      order: ['mirror', 'favorite', 'angle', 'share', 'queue'] as const,
      visible: { mirror: false, favorite: false, angle: false, share: false, queue: false },
    };
    const { container } = render(createElement(PlayDrawerActionBar, { ...workoutProps, buttons: allOff }));

    expect(container.querySelector('[data-workout-outcome]')).toBeTruthy();
  });

  it('gives way to the busy-wall question', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...workoutProps,
        commitButton: 'confirm' as const,
        onCommit: vi.fn(),
        onKeepTheirs: vi.fn(),
      }),
    );

    expect(container.querySelector('[data-commit-bar]')).toBeTruthy();
    expect(container.querySelector('[data-workout-outcome]')).toBeNull();
  });

  it('puts the bulb back in its slot over the connect pill', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...workoutProps, connectPill: true }));

    expect(container.querySelector('[data-connect-pill]')).toBeNull();
    expect(container.querySelector('[data-ble]')).toBeTruthy();
    expect(container.querySelector('[data-workout-outcome]')).toBeTruthy();
  });

  it('never reaches a signed-out reader', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...workoutProps, viewer: 'anonymous' as const }));

    expect(container.querySelector('[data-workout-outcome]')).toBeNull();
    expect(container.querySelector(`[data-label="${SHARE_LABEL}"]`)).toBeTruthy();
  });

  it('leaves the bar as it was outside a timed block', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, workoutOutcome: null }));

    expect(container.querySelector('[data-workout-outcome]')).toBeNull();
    expect(container.querySelector(`[data-label="${FAVORITE_LABEL}"]`)).toBeTruthy();
  });
});

// The bug this pins (#6231 simulator QA): at the end of an on-the-minute block
// the beat moved the wall onto a climb outside it, the player's gate turned off
// at once, and a tap on its way to Fell opened Choose Angle. The player now
// holds Fell / Sent for the climb the wall left (`useWorkoutOutcomeHold`) and
// hands the bar the held row.
describe('PlayDrawerActionBar (the wall leaves a timed block)', () => {
  const START_MS = 1_760_000_000_000;
  const limitTarget = {
    climb: { uuid: 'climb-1', name: 'Crimp line' } as unknown as Climb,
    queueItemUuid: 'item-1',
    sessionId: 'session-1',
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    isMirror: false,
  };

  type HeldBarProps = {
    live: typeof limitTarget | null;
    committedQueueItemUuid: string;
    onToggleFavorite: () => void;
    onOpenAngleSelector: () => void;
  };

  /** What PlayCore does: the hold decides the row, the bar draws it. */
  function HeldBar({ live, committedQueueItemUuid, onToggleFavorite, onOpenAngleSelector }: HeldBarProps) {
    const shown = useWorkoutOutcomeHold({
      live,
      committedQueueItemUuid,
      displayedQueueItemUuid: committedQueueItemUuid,
      sessionId: 'session-1',
      canLog: true,
    });
    return createElement(PlayDrawerActionBar, {
      ...baseProps,
      onToggleFavorite,
      onOpenAngleSelector,
      workoutOutcome: shown?.target ?? null,
      workoutOutcomeWallLeftAtMs: shown?.wallLeftAtMs ?? null,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    workoutOutcomeRow.onFell.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderThroughTheBeat() {
    const onToggleFavorite = vi.fn();
    const onOpenAngleSelector = vi.fn();
    const handlers = { onToggleFavorite, onOpenAngleSelector };
    const rendered = render(
      createElement(HeldBar, { live: limitTarget, committedQueueItemUuid: 'item-1', ...handlers }),
    );
    // The beat: the wall moves to the cool-down climb, which has no Fell / Sent.
    rendered.rerender(createElement(HeldBar, { live: null, committedQueueItemUuid: 'item-cool', ...handlers }));
    return { ...rendered, ...handlers };
  }

  it('a Fell tap 300 ms after the beat lands on Fell for the climb it left, not on the angle or the heart', () => {
    const { container, onToggleFavorite, onOpenAngleSelector } = renderThroughTheBeat();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    const row = container.querySelector('[data-workout-outcome]');
    expect(row?.getAttribute('data-workout-outcome')).toBe('item-1');
    expect(row?.getAttribute('data-wall-left-at')).toBe(String(START_MS));
    expect(container.querySelector(`[data-label="${ANGLE_LABEL}"]`)).toBeNull();
    expect(container.querySelector(`[data-label="${FAVORITE_LABEL}"]`)).toBeNull();

    fireEvent.click(container.querySelector('[data-workout-outcome-fell]') as HTMLElement);

    expect(workoutOutcomeRow.onFell).toHaveBeenCalledWith('item-1');
    expect(onOpenAngleSelector).not.toHaveBeenCalled();
    expect(onToggleFavorite).not.toHaveBeenCalled();
  });

  it('brings the normal row back after the grace, and it works', () => {
    const { container, onToggleFavorite, onOpenAngleSelector } = renderThroughTheBeat();

    act(() => {
      vi.advanceTimersByTime(WALL_MOVED_GRACE_MS);
    });

    expect(container.querySelector('[data-workout-outcome]')).toBeNull();
    fireEvent.click(container.querySelector(`[data-label="${ANGLE_LABEL}"]`) as HTMLElement);
    fireEvent.click(container.querySelector(`[data-label="${FAVORITE_LABEL}"]`) as HTMLElement);
    expect(onOpenAngleSelector).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(workoutOutcomeRow.onFell).not.toHaveBeenCalled();
  });
});
