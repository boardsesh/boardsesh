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
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

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
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
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
    onPress,
  }: {
    iconName?: string;
    iconColor?: string;
    checked?: boolean;
    accessibilityLabel?: string;
    accessibilityValueText?: string;
    onPress?: () => void;
  }) =>
    createElement('div', {
      onClick: onPress,
      'data-action': iconName,
      'data-icon-color': iconColor,
      'data-checked': checked == null ? undefined : String(checked),
      'data-label': accessibilityLabel,
      'data-value': accessibilityValueText,
    }),
  drawerActionBarStyles: {
    container: {},
    rowPrimary: {},
    primarySlot: {},
    rowSecondary: {},
    spacer: {},
    actionButton: {},
    actionButtonPressed: {},
  },
}));
// The commit-row content is covered by its own test; stubbed here (it pulls
// reanimated) so this file stays a pure prop-contract test of the bar itself.
vi.mock('../PlayDrawerCommitBar', () => ({
  PlayDrawerCommitBar: ({ commitLabel }: { commitLabel?: string }) =>
    createElement('div', { 'data-commit-bar': 'true', 'data-commit-label': commitLabel }),
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
  onOpenActions: vi.fn(),
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
  ellipsis: 'more',
  queue: 'queue',
} as const;

function actions(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-action]')].map((node) => node.getAttribute('data-action') ?? '');
}

describe('PlayDrawerActionBar', () => {
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

// The second row is either the utilities OR the browse latch's controls — never
// both, and never a new band. Every assertion below is about the SWAP, because
// the drawer's height budget is the whole reason the commit controls live in a
// row that already exists.
describe('PlayDrawerActionBar (secondary row swap)', () => {
  const commitProps = {
    ...baseProps,
    secondaryMode: 'commit' as const,
    showBackToLive: true,
    showPutOnWall: true,
    commitLabel: 'putOnWall' as const,
    onBackToLive: vi.fn(),
    onCommit: vi.fn(),
  };

  it('replaces the utilities with the commit controls while the latch is up', () => {
    const { container } = render(createElement(PlayDrawerActionBar, commitProps));

    expect(container.querySelector('[data-commit-bar="true"]')).toBeTruthy();
    // The row's own contents are gone for the duration — that's the trade the
    // spec makes to keep the row at 64pt.
    expect(container.querySelector('[data-label="mobile.angleSelector.title"]')).toBeNull();
    expect(actions(container)).not.toContain(ACTION_ICONS.queue);
    expect(container.querySelector('[data-icon="share"]')).toBeNull();
    // The primary row still acts on the displayed climb.
    expect(container.querySelector('[data-icon="tick.outline"]')).toBeTruthy();
  });

  it('keeps the utilities when the latch is down', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...commitProps, secondaryMode: 'actions' }));

    expect(container.querySelector('[data-commit-bar="true"]')).toBeNull();
    expect(container.querySelector('[data-label="mobile.angleSelector.title"]')).toBeTruthy();
  });

  it('never gives a signed-out reader the commit controls', () => {
    // The anonymous drawer is ALWAYS a preview, so a resolver bug that let
    // `'commit'` through would put a live `setCurrentClimb` button — the queue
    // write and BLE re-arm every other anonymous rule removes — on every
    // read-only open. The suppression is asserted HERE, not only in the
    // resolver, because the bar is the last gate before it renders.
    const { container } = render(
      createElement(PlayDrawerActionBar, { ...commitProps, viewer: 'anonymous' as const, onSignInPress: vi.fn() }),
    );

    expect(container.querySelector('[data-commit-bar="true"]')).toBeNull();
  });

  it.each(['commit', 'actions'] as const)('has no heatmap flame in %s mode', (secondaryMode) => {
    // The heatmap lives where holds get picked (hold filter, create climb), not
    // on a single climb.
    const { container } = render(createElement(PlayDrawerActionBar, { ...commitProps, secondaryMode }));
    expect(container.querySelector('[data-action="flame"], [data-action="flame.fill"]')).toBeNull();
  });

  it('passes the context-sensitive commit label through', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...commitProps, commitLabel: 'setActive' }));

    expect(container.querySelector('[data-commit-bar="true"]')?.getAttribute('data-commit-label')).toBe('setActive');
  });
});

// The signed-out reader on app.boardsesh.com's read-only climb URL. Every
// affordance is asserted individually rather than as one "renders no write
// buttons" sweep: flipping a single gate is a distinct product regression (a
// heart that 401s; a missing tick that turns the surface into a dead end), and a
// blanket assertion could not tell them apart.
describe('PlayDrawerActionBar (anonymous viewer)', () => {
  const anonymousProps = { ...baseProps, viewer: 'anonymous' as const, onSignInPress: vi.fn() };

  it('removes the queue, favourite, lightbulb and climb-actions affordances', () => {
    const { container } = render(createElement(PlayDrawerActionBar, anonymousProps));
    const rendered = actions(container);

    expect(rendered).not.toContain(ACTION_ICONS.queue);
    expect(rendered).not.toContain(ACTION_ICONS.favorite);
    expect(rendered).not.toContain(ACTION_ICONS.favoriteFilled);
    expect(rendered).not.toContain(ACTION_ICONS.ellipsis);
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(container.querySelector('[data-lightbulb-holder-badge="true"]')).toBeNull();
  });

  // On a board with no mirror support the heart normally takes the first primary
  // slot; anonymously that fallback has to go too, or the removal above is only
  // half true.
  it('does not fall back to the heart in the first slot on a fixed-mirror board', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...anonymousProps, supportsMirroring: false }));

    expect(actions(container)).not.toContain(ACTION_ICONS.favorite);
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
    expect(rendered).toContain(ACTION_ICONS.ellipsis);
    expect(container.querySelector('[data-ble="true"]')).toBeTruthy();
    expect(container.querySelector('[data-label="playView.tickFab.logAscentAria"]')).toBeTruthy();
  });
});

// #5654, PR 7: the connect-step treatment turns the bulb into a labelled pill at
// the right end of the second row. Share and queue go to ⋯ (the host adds them
// to that menu); the tick keeps its slot.
describe('PlayDrawerActionBar (connect-step pill)', () => {
  const pillProps = { ...baseProps, connectPill: true };

  it('moves the bulb into the second row as the pill, and share and queue out of it', () => {
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

  it('gives the pill its own tap when the host passes one, so its connects log as the pill', () => {
    const onLightbulb = vi.fn();
    const onConnectPill = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...pillProps, onLightbulb, onConnectPill }));

    (container.querySelector('[data-connect-pill="true"]') as HTMLElement).click();

    expect(onConnectPill).toHaveBeenCalledTimes(1);
    expect(onLightbulb).not.toHaveBeenCalled();
  });

  it('keeps the tick, the heart, the angle and ⋯', () => {
    const { container } = render(createElement(PlayDrawerActionBar, pillProps));
    const rendered = actions(container);

    expect(container.querySelector('[data-icon="tick.outline"]')).toBeTruthy();
    expect(rendered).toContain(ACTION_ICONS.favorite);
    expect(rendered).toContain(ACTION_ICONS.ellipsis);
    expect(container.querySelector('[data-label="mobile.angleSelector.title"]')).toBeTruthy();
  });

  it('shows a connect in flight on the pill', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...pillProps, lightbulbPending: true }));

    expect(container.querySelector('[data-connect-pill="true"]')?.getAttribute('data-pending')).toBe('true');
  });

  it('gives way to the commit controls while the latch is up', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...pillProps,
        secondaryMode: 'commit' as const,
        onBackToLive: vi.fn(),
        onCommit: vi.fn(),
      }),
    );

    expect(container.querySelector('[data-connect-pill="true"]')).toBeNull();
    expect(container.querySelector('[data-commit-bar="true"]')).toBeTruthy();
    // The bulb is back in its slot rather than lost.
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
