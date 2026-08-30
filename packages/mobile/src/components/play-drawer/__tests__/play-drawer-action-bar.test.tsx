// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

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
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
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
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
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
  ActionButton: ({ iconName }: { iconName?: string }) => createElement('div', { 'data-action': iconName }),
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
vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#6D28D9', success: '#047857' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#6D28D9', success: '#047857' },
    systemColors: { fill: 'rgba(109, 40, 217, 0.14)' },
  }),
}));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#FFFFFF', systemGray: '#8E8E93', systemRed: '#FF3B30', separator: '#ccc' },
}));
vi.mock('../../../theme/layout', () => ({ glassSize: { mini: 32 } }));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

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

  it('omits share when the board has no public climb view', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, onShare: undefined }));

    expect(container.querySelector('[data-icon="share"]')).toBeNull();
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
