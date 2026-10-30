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
// The bulb has its own test; here only where it goes and the model it is handed.
vi.mock('../WallControlBulb', () => ({
  WallControlBulb: ({
    model,
    showFace,
    onPress,
    onLongPress,
  }: {
    model: { state: string | null; look: string; holder: string | null; holderFace: unknown; longPress: string | null };
    showFace?: boolean;
    onPress: () => void;
    onLongPress: () => void;
  }) =>
    createElement('div', {
      'data-ble': 'true',
      onClick: onPress,
      onContextMenu: onLongPress,
      'data-state': model.state ?? 'none',
      'data-look': model.look,
      'data-face': showFace !== false && model.holderFace ? 'true' : 'false',
    }),
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
    badge,
  }: {
    iconName?: string;
    iconColor?: string;
    checked?: boolean;
    accessibilityLabel?: string;
    accessibilityValueText?: string;
    testID?: string;
    size?: string;
    onPress?: () => void;
    badge?: ReactNode;
  }) =>
    createElement(
      'div',
      {
        onClick: onPress,
        'data-action': iconName,
        'data-testid': testID,
        'data-size': size,
        'data-icon-color': iconColor,
        'data-checked': checked == null ? undefined : String(checked),
        'data-label': accessibilityLabel,
        'data-value': accessibilityValueText,
      },
      badge,
    ),
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
vi.mock('../BusyWallQuestionGroup', () => ({
  BusyWallQuestionGroup: ({
    model,
    onKeep,
    onPut,
  }: {
    model: { holderName: string | null; wallClimbName: string };
    onKeep: () => void;
    onPut: () => void;
  }) =>
    createElement(
      'div',
      {
        'data-commit-bar': 'true',
        'data-wall-climb': model.wallClimbName,
        'data-holder': model.holderName ?? '',
      },
      createElement('button', { 'data-keep-theirs': 'true', onClick: onKeep }),
      createElement('button', { 'data-confirm': 'true', onClick: onPut }),
    ),
}));
// The wall button has its own test; here only where it goes and what it is handed.
vi.mock('../WallControlButton', () => ({
  WALL_CONTROL_HEIGHT: 44,
  WallControlButton: ({
    model,
    compact,
    spansRow,
    onPress,
    onLongPress,
  }: {
    model: { state: string | null; holder: string | null };
    compact?: boolean;
    spansRow?: boolean;
    onPress: () => void;
    onLongPress: () => void;
  }) =>
    createElement('button', {
      'data-wall-control': model.state ?? 'none',
      'data-holder': model.holder ?? 'none',
      'data-compact': compact ? 'true' : 'false',
      'data-spans-row': spansRow ? 'true' : 'false',
      onClick: onPress,
      onContextMenu: onLongPress,
    }),
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
import { EMPTY_WALL_CONTROL, type WallControlModel } from '../wall-control';
import { resolveBusyWallQuestion } from '../busy-wall-question';
import { useWorkoutOutcomeHold } from '../use-workout-outcome-hold';
import { WALL_MOVED_GRACE_MS } from '../workout-outcome';

/** A board to connect: what the player hands the bar with no link up. */
const BUSY_WALL = resolveBusyWallQuestion({
  holder: { name: 'Test2', avatarUrl: null },
  wallClimbName: 'Moonlight Sonata',
  selfHoldsBoard: true,
  ready: true,
});
const CONNECT_MODEL: WallControlModel = { ...EMPTY_WALL_CONTROL, state: 'connect', tapAction: 'connect' };
/** This phone holds the board and the climb is lit. */
const LIT_MODEL: WallControlModel = {
  ...EMPTY_WALL_CONTROL,
  state: 'lit',
  holder: 'self',
  holderFace: { name: 'Me', avatarUrl: null },
  tapAction: 'disconnect',
  longPress: 'sheet',
  look: 'lit',
  selected: true,
};

const baseProps = {
  canSwipePrevious: true,
  canSwipeNext: true,
  isMirrored: false,
  supportsMirroring: true,
  isFavorited: false,
  remainingQueueCount: 3,
  wallControl: CONNECT_MODEL,
  onWallControlPress: vi.fn(),
  onWallControlLongPress: vi.fn(),
  ascentCount: 2,
  currentAngle: 40,
  onPrevClick: vi.fn(),
  onNextClick: vi.fn(),
  onMirror: vi.fn(),
  onToggleFavorite: vi.fn(),
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

  // #7000: [♡] [⏮] [✓] [⏭] [☰] over the wall button.
  it('leads with the heart and ends with the queue on a board without mirror, over the wall button', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, supportsMirroring: false }));
    const order = labels(container);

    expect(order[0]).toBe(FAVORITE_LABEL);
    expect(container.querySelector(`[data-label="${FAVORITE_LABEL}"]`)?.getAttribute('data-size')).toBe('lg');
    expect(container.querySelector(`[data-label="${QUEUE_LABEL}"]`)?.getAttribute('data-size')).toBe('lg');
    expect(order.at(-1)).toBe(QUEUE_LABEL);
    expect(actions(container)).not.toContain(ACTION_ICONS.mirror);
    expect(container.querySelector('[data-wall-control]')).not.toBeNull();
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
  });

  // [⇄] [⏮] [✓] [⏭] [☰] over the wall button; the heart lives in ⋯.
  it('keeps Mirror first on a mirror board, with no heart in either row', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    const order = labels(container);

    expect(order[0]).toBe('playView.actionBar.mirrorAria');
    expect(order).not.toContain(FAVORITE_LABEL);
    expect(order.at(-1)).toBe(QUEUE_LABEL);
  });

  it('draws Share and Angle in neither row: they are ⋯ rows', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    expect(labels(container)).not.toContain(SHARE_LABEL);
    expect(labels(container)).not.toContain(ANGLE_LABEL);
  });

  it('renders the tick as a green glyph (colour on the icon, not a solid fill)', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    const tick = container.querySelector('[data-icon="tick.outline"]') as HTMLElement;

    expect(tick).toBeTruthy();
    expect(tick.getAttribute('data-color')).toBe('#047857');
    expect(container.querySelector('[data-icon="tick.outline"][data-color="#FFFFFF"]')).toBeNull();
  });

  it.each(['liquidGlass', 'material'] as const)('keeps the favourite colour on %s', (variant) => {
    themeState.variant = variant;
    const { container } = render(
      createElement(PlayDrawerActionBar, { ...baseProps, supportsMirroring: false, isFavorited: true }),
    );
    expect(
      container.querySelector(`[data-action="${ACTION_ICONS.favoriteFilled}"]`)?.getAttribute('data-icon-color'),
    ).toBe('favoriteSelected');
  });

  it('hands the wall button the model, and says the tap and the hold came from the button', () => {
    const onWallControlPress = vi.fn();
    const onWallControlLongPress = vi.fn();
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        wallControl: LIT_MODEL,
        onWallControlPress,
        onWallControlLongPress,
      }),
    );
    const wallControl = container.querySelector('[data-wall-control]') as HTMLElement;
    expect(wallControl.dataset).toMatchObject({ wallControl: 'lit', holder: 'self', compact: 'false' });
    fireEvent.click(wallControl);
    fireEvent.contextMenu(wallControl);
    expect(onWallControlPress).toHaveBeenCalledWith('button');
    expect(onWallControlLongPress).toHaveBeenCalledWith('button');
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
});

describe("PlayDrawerActionBar (the climber's buttons)", () => {
  const order = ['mirror', 'favorite', 'queue', 'share', 'angle'] as const;
  const visibleAll = { mirror: true, favorite: true, angle: true, share: true, queue: true };

  it('leaves both ⏮ ⏭ slots empty with Previous and next off, keeping the tick in the middle slot', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, previousNext: false }));
    expect(actions(container)).not.toContain(ACTION_ICONS.previous);
    expect(actions(container)).not.toContain(ACTION_ICONS.next);
    expect(container.querySelector('[data-icon="tick.outline"]')).toBeTruthy();
  });

  it('gives the heart the leading slot on a mirror board with Mirror switched off', () => {
    const buttons = { order, visible: { ...visibleAll, mirror: false } };
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, buttons }));
    expect(labels(container)[0]).toBe(FAVORITE_LABEL);
  });

  // The first button on takes the leading slot and the last one the trailing
  // slot; the ones between go to ⋯.
  it('puts the first and last buttons on at the two ends and none of the middle ones', () => {
    const buttons = { order: ['angle', 'mirror', 'favorite', 'queue', 'share'] as const, visible: visibleAll };
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, buttons }));
    const drawn = labels(container);
    expect(drawn[0]).toBe(ANGLE_LABEL);
    expect(drawn).toContain(SHARE_LABEL);
    expect(drawn).not.toContain(FAVORITE_LABEL);
    expect(drawn).not.toContain(QUEUE_LABEL);
    expect(actions(container)).not.toContain(ACTION_ICONS.mirror);
  });

  it('draws one button at the leading end alone', () => {
    const buttons = { order, visible: { mirror: false, favorite: false, queue: true, share: false, angle: false } };
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, buttons }));
    expect(labels(container)[0]).toBe(QUEUE_LABEL);
    expect(labels(container).filter((label) => label === QUEUE_LABEL)).toHaveLength(1);
  });

  it('collapses the second row when there is no wall to light', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, hasWall: false }));
    expect(container.querySelector('[data-wall-control]')).toBeNull();
    expect(container.querySelector('[data-icon="tick.outline"]')).toBeTruthy();
  });

  it('keeps the wall button with every button switched off', () => {
    const allOff = { order, visible: { mirror: false, favorite: false, angle: false, share: false, queue: false } };
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, buttons: allOff }));
    expect(container.querySelector('[data-wall-control]')).not.toBeNull();
    expect(labels(container)).not.toContain(QUEUE_LABEL);
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

// The busy-wall question (#7017) takes the wall button's row as a pair; the
// first row stays exactly as it was, and nothing draws over it.
describe('PlayDrawerActionBar (the busy-wall question)', () => {
  const confirmProps = {
    ...baseProps,
    commitButton: 'confirm' as const,
    busyWall: BUSY_WALL,
    onCommit: vi.fn(),
    onKeepTheirs: vi.fn(),
  };

  it('swaps the wall button for the question’s pair, and leaves the first row as it was', () => {
    const { container } = render(createElement(PlayDrawerActionBar, confirmProps));
    const bar = container.querySelector('[data-commit-bar="true"]') as HTMLElement;
    const plain = render(createElement(PlayDrawerActionBar, baseProps)).container;

    expect(bar.getAttribute('data-wall-climb')).toBe('Moonlight Sonata');
    expect(bar.getAttribute('data-holder')).toBe('Test2');
    expect(container.querySelector('[data-wall-control]')).toBeNull();
    // Put mine up carries the bulb, so the bulb doesn't come back.
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(container.querySelector('[data-icon="tick.outline"]')).not.toBeNull();
    expect(actions(container)).toEqual(actions(plain));
    expect(labels(container)).toContain(QUEUE_LABEL);
  });

  it('stands the question down when the host has no model for it', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...confirmProps, busyWall: null }));
    expect(container.querySelector('[data-commit-bar="true"]')).toBeNull();
    expect(container.querySelector('[data-wall-control]')).not.toBeNull();
  });

  it('keeps the bulb in the first row for the question with the bulb chosen', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, { ...confirmProps, boardControl: 'lightbulb' as const }),
    );
    expect(container.querySelector('[data-commit-bar="true"]')).not.toBeNull();
    expect(container.querySelector('[data-ble="true"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="tick.outline"]')).not.toBeNull();
  });

  it('routes Put mine up to the commit and Keep theirs to its own handler', () => {
    const onCommit = vi.fn();
    const onKeepTheirs = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...confirmProps, onCommit, onKeepTheirs }));
    fireEvent.click(container.querySelector('[data-confirm="true"]') as HTMLElement);
    fireEvent.click(container.querySelector('[data-keep-theirs="true"]') as HTMLElement);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onKeepTheirs).toHaveBeenCalledOnce();
  });

  it('stands the question down when the host did not hand it Keep theirs', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...confirmProps, onKeepTheirs: undefined }));
    expect(container.querySelector('[data-commit-bar="true"]')).toBeNull();
    expect(container.querySelector('[data-wall-control]')).not.toBeNull();
  });

  it('never gives it to a signed-out reader', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...confirmProps, viewer: 'anonymous' as const }));
    expect(container.querySelector('[data-commit-bar="true"]')).toBeNull();
    expect(labels(container)).toContain(SHARE_LABEL);
  });
});

// The bulb is back in the first row while the second row is taken.
// #7000, the tablet rule: beside a MiniPlayer the first row is the wall button.
describe('PlayDrawerActionBar (beside a MiniPlayer, tablets and the open Duo)', () => {
  const besideProps = { ...baseProps, miniPlayerMirrors: true, wallControl: LIT_MODEL };

  it('puts the full-width wall button in the first row, with no icon buttons and no second row', () => {
    const { container } = render(createElement(PlayDrawerActionBar, besideProps));
    const row = container.querySelector('[data-testid="play-drawer-action-bar-wall-row"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-wall-control]')?.getAttribute('data-compact')).toBe('false');
    expect(actions(container)).toEqual([]);
    expect(container.querySelector('[data-icon="tick.outline"]')).toBeNull();
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(container.querySelectorAll('[data-wall-control]')).toHaveLength(1);
  });

  it('keeps Fell / Sent in the second row', () => {
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
    const { container } = render(createElement(PlayDrawerActionBar, { ...besideProps, workoutOutcome }));
    expect(container.querySelector('[data-workout-outcome]')).not.toBeNull();
    expect(container.querySelector('[data-testid="play-drawer-action-bar-wall-row"]')).not.toBeNull();
  });

  it('puts the busy-wall question’s pair in the wall button’s place, the first row', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...besideProps,
        commitButton: 'confirm' as const,
        busyWall: BUSY_WALL,
        onCommit: vi.fn(),
        onKeepTheirs: vi.fn(),
      }),
    );
    const row = container.querySelector('[data-testid="play-drawer-action-bar-wall-row"]');
    expect(row?.querySelector('[data-commit-bar="true"]')).not.toBeNull();
    expect(container.querySelector('[data-wall-control]')).toBeNull();
    expect(container.querySelectorAll('[data-commit-bar="true"]')).toHaveLength(1);
  });

  it('keeps the busy-wall question in the second row with the bulb chosen: there is no first row', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...besideProps,
        boardControl: 'lightbulb' as const,
        commitButton: 'confirm' as const,
        busyWall: BUSY_WALL,
        onCommit: vi.fn(),
        onKeepTheirs: vi.fn(),
      }),
    );
    expect(container.querySelector('[data-commit-bar="true"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="play-drawer-action-bar-wall-row"]')).toBeNull();
  });

  it('draws no first row with the bulb chosen: the bar has the bulb', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, { ...besideProps, boardControl: 'lightbulb' as const }),
    );
    expect(container.querySelector('[data-wall-control]')).toBeNull();
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(actions(container)).toEqual([]);
  });
});

describe('PlayDrawerActionBar (the bulb chosen)', () => {
  const backProps = { ...baseProps, boardControl: 'lightbulb' as const };

  // The row stays, so the board never jumps: ⇄ ⏮ ✓ ⏭ 💡 over ♡ ··· ☰.
  it('keeps the second row with the other buttons small on its sides, and Put on the wall in the gap', () => {
    const plain = render(createElement(PlayDrawerActionBar, backProps));
    expect(plain.container.querySelector(`[data-label="${FAVORITE_LABEL}"]`)?.getAttribute('data-size')).toBe('sm');
    expect(plain.container.querySelector(`[data-label="${QUEUE_LABEL}"]`)?.getAttribute('data-size')).toBe('sm');
    expect(plain.container.querySelector('[data-wall-control]')).toBeNull();
    plain.unmount();

    const preview = render(
      createElement(PlayDrawerActionBar, {
        ...backProps,
        commitButton: 'putOnWall' as const,
        onCommit: vi.fn(),
        wallControl: { ...CONNECT_MODEL, state: 'put_on_wall' as const },
      }),
    );
    expect(preview.container.querySelector('[data-wall-control]')?.getAttribute('data-wall-control')).toBe(
      'put_on_wall',
    );
    expect(labels(preview.container)).toEqual(expect.arrayContaining([FAVORITE_LABEL, QUEUE_LABEL]));
  });

  it('draws the same model as the wall button, and says the tap and the hold came from the bulb', () => {
    const onWallControlPress = vi.fn();
    const onWallControlLongPress = vi.fn();
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...backProps,
        wallControl: LIT_MODEL,
        onWallControlPress,
        onWallControlLongPress,
      }),
    );
    const bulb = container.querySelector('[data-ble="true"]') as HTMLElement;
    expect(bulb.dataset).toMatchObject({ state: 'lit', look: 'lit', face: 'true' });
    fireEvent.click(bulb);
    fireEvent.contextMenu(bulb);
    expect(onWallControlPress).toHaveBeenCalledWith('bulb');
    expect(onWallControlLongPress).toHaveBeenCalledWith('bulb');
  });

  it('keeps the model’s face unless the back chip owns the driver’s face', () => {
    const withFace = render(createElement(PlayDrawerActionBar, { ...backProps, wallControl: LIT_MODEL }));
    expect(withFace.container.querySelector('[data-ble="true"]')?.getAttribute('data-face')).toBe('true');
    withFace.unmount();
    const noFace = render(
      createElement(PlayDrawerActionBar, { ...backProps, wallControl: LIT_MODEL, showHolderBadge: false }),
    );
    expect(noFace.container.querySelector('[data-ble="true"]')?.getAttribute('data-face')).toBe('false');
  });

  it('keeps the queue in its slot where there is no Bluetooth to reconnect', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...backProps, showLightbulb: false }));
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(labels(container)).toContain(QUEUE_LABEL);
  });
});

describe('PlayDrawerActionBar (anonymous viewer)', () => {
  const anonymousProps = { ...baseProps, viewer: 'anonymous' as const, onSignInPress: vi.fn() };

  it('removes the queue, favourite, lightbulb and wall button affordances', () => {
    const { container } = render(createElement(PlayDrawerActionBar, anonymousProps));
    const rendered = actions(container);

    expect(rendered).not.toContain(ACTION_ICONS.queue);
    expect(rendered).not.toContain(ACTION_ICONS.favorite);
    expect(rendered).not.toContain(ACTION_ICONS.favoriteFilled);
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(container.querySelector('[data-lightbulb-holder-badge="true"]')).toBeNull();
    expect(container.querySelector('[data-wall-control]')).toBeNull();
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

  it('keeps the 32pt angle pill tappable at the 44pt floor via hit-slop', () => {
    const { container } = render(createElement(PlayDrawerActionBar, anonymousProps));
    const anglePill = container.querySelector('[data-label="mobile.angleSelector.title"]') as HTMLElement;

    expect(anglePill).toBeTruthy();
    expect(anglePill.textContent).toContain('40°');
    expect(Number(anglePill.getAttribute('data-hitslop'))).toBeGreaterThanOrEqual(6);
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
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, supportsMirroring: false }));
    const rendered = actions(container);

    expect(rendered).toContain(ACTION_ICONS.queue);
    expect(rendered).toContain(ACTION_ICONS.favorite);
    expect(container.querySelector('[data-wall-control]')).toBeTruthy();
    expect(container.querySelector('[data-label="playView.tickFab.logAscentAria"]')).toBeTruthy();
  });
});

describe('PlayDrawerActionBar haptics', () => {
  function press(container: HTMLElement, selector: string) {
    const node = container.querySelector(selector);
    if (!node) throw new Error(`nothing matches ${selector}`);
    fireEvent.click(node);
  }

  it('gives prev, next and the tick no haptic, and still runs them', () => {
    haptics.hapticMedium.mockClear();
    haptics.hapticSelection.mockClear();
    const onPrevClick = vi.fn();
    const onNextClick = vi.fn();
    const onTickPress = vi.fn();
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        onPrevClick,
        onNextClick,
        onTickPress,
      }),
    );
    press(container, `[data-action="${ACTION_ICONS.previous}"]`);
    press(container, `[data-action="${ACTION_ICONS.next}"]`);
    press(container, '[data-label="playView.tickFab.logAscentAria"]');

    expect(onPrevClick).toHaveBeenCalledTimes(1);
    expect(onNextClick).toHaveBeenCalledTimes(1);
    expect(onTickPress).toHaveBeenCalledTimes(1);
    expect(haptics.hapticMedium).not.toHaveBeenCalled();
    expect(haptics.hapticSelection).not.toHaveBeenCalled();
  });

  it('ticks a selection for the mirror and favourite toggles', () => {
    haptics.hapticMedium.mockClear();
    haptics.hapticSelection.mockClear();
    const onMirror = vi.fn();
    const onToggleFavorite = vi.fn();
    const mirrorBoard = render(createElement(PlayDrawerActionBar, { ...baseProps, onMirror }));
    press(mirrorBoard.container, `[data-action="${ACTION_ICONS.mirror}"]`);
    mirrorBoard.unmount();
    const { container } = render(
      createElement(PlayDrawerActionBar, { ...baseProps, supportsMirroring: false, onToggleFavorite }),
    );
    press(container, `[data-action="${ACTION_ICONS.favorite}"]`);

    expect(onMirror).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(haptics.hapticSelection).toHaveBeenCalledTimes(2);
    expect(haptics.hapticMedium).not.toHaveBeenCalled();
  });

  // #6238: walking a list, Next plays the list, so the queue button keeps Up
  // next in sight with a badge and says it out loud.
  describe('the Up next badge while a list is walked', () => {
    const UP_NEXT_LABEL = 'playView.actionBar.queueUpNextAria';
    const badge = (container: HTMLElement) => container.querySelector('[data-testid="play-drawer-queue-badge"]');

    it.each([
      ['a mirror board', true, 'lg'],
      ['a board without mirror', false, 'lg'],
    ] as const)('badges the queue button on %s with the Up next count', (_where, supportsMirroring, size) => {
      const { container } = render(
        createElement(PlayDrawerActionBar, { ...baseProps, supportsMirroring, upNextBadgeCount: 3 }),
      );

      const queueButton = container.querySelector(`[data-action="${ACTION_ICONS.queue}"]`);
      // Inside the button, so it presses with it like the tick count.
      expect(queueButton?.querySelector('[data-testid="play-drawer-queue-badge"]')?.textContent).toBe('3');
      expect(queueButton?.getAttribute('data-label')).toBe(UP_NEXT_LABEL);
      expect(queueButton?.getAttribute('data-size')).toBe(size);
    });

    it('draws no badge at zero, but still speaks Up next while the list is walked', () => {
      // "Queue, 12 climbs" here would count the list ahead over an empty queue.
      const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, upNextBadgeCount: 0 }));

      expect(badge(container)).toBeNull();
      expect(container.querySelector(`[data-action="${ACTION_ICONS.queue}"]`)?.getAttribute('data-label')).toBe(
        UP_NEXT_LABEL,
      );
    });

    it('draws no badge and keeps the plain queue label when no list is walked', () => {
      const { container } = render(createElement(PlayDrawerActionBar, baseProps));
      expect(badge(container)).toBeNull();
      expect(container.querySelector(`[data-action="${ACTION_ICONS.queue}"]`)?.getAttribute('data-label')).toBe(
        QUEUE_LABEL,
      );
    });

    it('caps a long queue at 99+', () => {
      const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, upNextBadgeCount: 140 }));
      expect(badge(container)?.textContent).toBe('99+');
    });

    it('caps the tick count beside it the same way', () => {
      const { container } = render(
        createElement(PlayDrawerActionBar, { ...baseProps, ascentCount: 140, upNextBadgeCount: 140 }),
      );
      expect(container.textContent?.match(/99\+/g)).toHaveLength(2);
    });
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

  // #7017 bug 1: React reused the `⏮ [wall button] ⏭` row's views for the
  // five slots when the block ended, and a stale style left the slots uneven
  // (✓ 23pt off centre, ☰ 53pt from ⏭). Each first row is its own mount.
  it('mounts a fresh first row when Fell / Sent hands it back, never the workout row’s views', () => {
    const view = render(createElement(PlayDrawerActionBar, workoutProps));
    const workoutRow = view.container.querySelector('[data-testid="play-drawer-action-bar-workout-row"]');
    const workoutSlots = [...(workoutRow?.children ?? [])];
    expect(workoutRow).not.toBeNull();

    view.rerender(createElement(PlayDrawerActionBar, { ...workoutProps, workoutOutcome: null }));
    const primaryRow = view.container.querySelector('[data-testid="play-drawer-action-bar-primary-row"]');
    expect(primaryRow).not.toBeNull();
    expect(primaryRow).not.toBe(workoutRow);
    for (const slot of primaryRow?.children ?? []) expect(workoutSlots).not.toContain(slot);
    expect(primaryRow?.children).toHaveLength(5);

    view.rerender(createElement(PlayDrawerActionBar, workoutProps));
    expect(view.container.querySelector('[data-testid="play-drawer-action-bar-workout-row"]')).not.toBe(workoutRow);
  });

  // #7000: the block keeps the wall button: ⏮ [wall button] ⏭ over Fell | Sent.
  it('gives the second row to Fell / Sent and moves the wall button between ⏮ and ⏭', () => {
    const { container } = render(createElement(PlayDrawerActionBar, workoutProps));

    expect(container.querySelector('[data-workout-outcome]')?.getAttribute('data-workout-outcome')).toBe('item-1');
    expect(container.querySelector('[data-testid="play-drawer-action-bar-workout-row"]')).not.toBeNull();
    expect(container.querySelector('[data-wall-control]')?.getAttribute('data-compact')).toBe('true');
    // Mirror, Log and the queue wait in ⋯; no bulb.
    expect(actions(container)).toEqual([ACTION_ICONS.previous, ACTION_ICONS.next]);
    expect(container.querySelector('[data-icon="tick.outline"]')).toBeNull();
    expect(container.querySelector('[data-ble="true"]')).toBeNull();
    expect(container.querySelector(`[data-label="${QUEUE_LABEL}"]`)).toBeNull();
  });

  it('keeps the same workout row on a board without mirror', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...workoutProps, supportsMirroring: false }));

    expect(labels(container)).not.toContain(FAVORITE_LABEL);
    expect(container.querySelector('[data-wall-control]')?.getAttribute('data-compact')).toBe('true');
    expect(container.querySelector('[data-workout-outcome]')).toBeTruthy();
  });

  it('keeps today’s workout row with the bulb chosen: ⇄ ⏮ ✓ ⏭ 💡 over Fell | Sent', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, { ...workoutProps, boardControl: 'lightbulb' as const }),
    );

    expect(actions(container)).toEqual([ACTION_ICONS.mirror, ACTION_ICONS.previous, ACTION_ICONS.next]);
    expect(container.querySelector('[data-icon="tick.outline"]')).not.toBeNull();
    expect(container.querySelector('[data-ble="true"]')).not.toBeNull();
    expect(container.querySelector('[data-wall-control]')).toBeNull();
    expect(container.querySelector('[data-workout-outcome]')).toBeTruthy();
  });

  it('hands the row the tick sheet opener, for a spray climb that needs a grade', () => {
    const onTickPress = vi.fn();
    const { container } = render(createElement(PlayDrawerActionBar, { ...workoutProps, onTickPress }));

    fireEvent.click(container.querySelector('[data-workout-outcome]') as HTMLElement);

    expect(onTickPress).toHaveBeenCalledTimes(1);
  });

  it('gives way to the busy-wall question', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...workoutProps,
        commitButton: 'confirm' as const,
        busyWall: BUSY_WALL,
        onCommit: vi.fn(),
        onKeepTheirs: vi.fn(),
      }),
    );

    expect(container.querySelector('[data-commit-bar]')).toBeTruthy();
    expect(container.querySelector('[data-workout-outcome]')).toBeNull();
  });

  it('gives way to Put on the wall for a preview: the wall button comes back', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...workoutProps,
        commitButton: 'putOnWall' as const,
        wallControl: { ...CONNECT_MODEL, state: 'put_on_wall' as const },
        onCommit: vi.fn(),
      }),
    );

    expect(container.querySelector('[data-wall-control]')?.getAttribute('data-wall-control')).toBe('put_on_wall');
    expect(container.querySelector('[data-workout-outcome]')).toBeNull();
  });

  it('never reaches a signed-out reader', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...workoutProps, viewer: 'anonymous' as const }));

    expect(container.querySelector('[data-workout-outcome]')).toBeNull();
    expect(container.querySelector(`[data-label="${SHARE_LABEL}"]`)).toBeTruthy();
  });

  it('leaves the bar as it was outside a timed block', () => {
    const { container } = render(createElement(PlayDrawerActionBar, { ...baseProps, workoutOutcome: null }));

    expect(container.querySelector('[data-workout-outcome]')).toBeNull();
    expect(container.querySelector('[data-wall-control]')).not.toBeNull();
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

  it('a Fell tap 300 ms after the beat lands on Fell for the climb it left, not on the wall button', () => {
    const { container, onToggleFavorite, onOpenAngleSelector } = renderThroughTheBeat();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    const row = container.querySelector('[data-workout-outcome]');
    expect(row?.getAttribute('data-workout-outcome')).toBe('item-1');
    expect(row?.getAttribute('data-wall-left-at')).toBe(String(START_MS));
    // The wall button stays in the top row for the held row (#7000), not in Fell's place.
    expect(container.querySelector('[data-wall-control]')?.getAttribute('data-compact')).toBe('true');

    fireEvent.click(container.querySelector('[data-workout-outcome-fell]') as HTMLElement);

    expect(workoutOutcomeRow.onFell).toHaveBeenCalledWith('item-1');
    expect(onOpenAngleSelector).not.toHaveBeenCalled();
    expect(onToggleFavorite).not.toHaveBeenCalled();
  });

  it('brings the wall button back after the grace', () => {
    const { container } = renderThroughTheBeat();

    act(() => {
      vi.advanceTimersByTime(WALL_MOVED_GRACE_MS);
    });

    expect(container.querySelector('[data-workout-outcome]')).toBeNull();
    expect(container.querySelector('[data-wall-control]')?.getAttribute('data-compact')).toBe('false');
    expect(workoutOutcomeRow.onFell).not.toHaveBeenCalled();
  });
});

// #7113 PR 5: on Android the wall button keeps clear of the edge Back zone
// wherever it reaches the screen's edges, which is where it is the one thing
// drawn in the second row. The button applies the inset (its own test); here,
// where it is told it spans its row.
describe('PlayDrawerActionBar: where the wall button spans its row', () => {
  const spansRow = (container: HTMLElement) =>
    container.querySelector('[data-wall-control]')?.getAttribute('data-spans-row');
  const order = ['mirror', 'favorite', 'queue', 'share', 'angle'] as const;
  const bulbPreview = {
    ...baseProps,
    boardControl: 'lightbulb' as const,
    commitButton: 'putOnWall' as const,
    onCommit: vi.fn(),
    wallControl: { ...CONNECT_MODEL, state: 'put_on_wall' as const },
  };

  it('spans the second row alone on a phone', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    expect(spansRow(container)).toBe('true');
  });

  it('does not beside a MiniPlayer, between the bulb row buttons, or in a workout top row', () => {
    const beside = render(
      createElement(PlayDrawerActionBar, { ...baseProps, miniPlayerMirrors: true, wallControl: LIT_MODEL }),
    );
    expect(spansRow(beside.container)).toBe('false');
    beside.unmount();

    const bulbRow = render(createElement(PlayDrawerActionBar, bulbPreview));
    expect(spansRow(bulbRow.container)).toBe('false');
    bulbRow.unmount();

    const workout = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        workoutOutcome: {
          climb: { uuid: 'climb-1' } as unknown as Climb,
          queueItemUuid: 'item-1',
          sessionId: 'session-1',
          boardName: 'tension',
          layoutId: 9,
          sizeId: 1,
          setIds: '1',
          angle: 40,
          isMirror: false,
        },
      }),
    );
    const workoutButton = workout.container.querySelector('[data-wall-control]');
    expect(workoutButton?.getAttribute('data-compact')).toBe('true');
    expect(workoutButton?.getAttribute('data-spans-row')).toBe('false');
  });

  it('counts what draws: beside a Share with nothing to share it spans the row', () => {
    const favoriteAndShare = {
      order,
      visible: { mirror: false, favorite: true, angle: false, share: true, queue: false },
    };
    const sharing = render(createElement(PlayDrawerActionBar, { ...bulbPreview, buttons: favoriteAndShare }));
    expect(spansRow(sharing.container)).toBe('false');
    sharing.unmount();

    const nothingToShare = render(
      createElement(PlayDrawerActionBar, { ...bulbPreview, buttons: favoriteAndShare, onShare: undefined }),
    );
    expect(spansRow(nothingToShare.container)).toBe('true');
  });
});
