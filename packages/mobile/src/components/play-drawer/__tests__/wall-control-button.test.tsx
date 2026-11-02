// @vitest-environment jsdom
// The player's wall button (#7000): it draws a board control model and nothing
// else. What it says in each state, whose face it shows (only the model's), and
// that a tap and a hold reach the handlers it is given.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };

const layoutCtrl = vi.hoisted(() => ({
  onLayout: undefined as undefined | ((event: { nativeEvent: { layout: { width: number; height: number } } }) => void),
  onAccessibilityAction: undefined as undefined | ((event: { nativeEvent: { actionName: string } }) => void),
}));
const themeCtrl = vi.hoisted(() => ({ scheme: 'light' as 'light' | 'dark' }));
const platformCtrl = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));
// Each render of the pressable, so a test can see what re-renders it.
const pressableCtrl = vi.hoisted(() => ({ renders: 0 }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    onLayout,
    children,
    onPress,
    onLongPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
    accessibilityValue,
    accessibilityActions,
    onAccessibilityAction,
    testID,
    style,
  }: Children & {
    accessibilityValue?: { text?: string };
    accessibilityActions?: { name: string; label?: string }[];
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityState?: { selected?: boolean; busy?: boolean };
    testID?: string;
    style?: (state: { pressed: boolean }) => unknown;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  }) => {
    pressableCtrl.renders += 1;
    return createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        onContextMenu: onLongPress,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-value': accessibilityValue?.text,
        'aria-selected': String(Boolean(accessibilityState?.selected)),
        'data-testid': testID,
        'data-long-press': onLongPress ? 'true' : 'false',
        'data-busy': String(Boolean(accessibilityState?.busy)),
        'data-actions': (accessibilityActions ?? []).map((action) => action.label).join('|'),
        'data-style': JSON.stringify(style?.({ pressed: false })),
        ref: () => {
          layoutCtrl.onLayout = onLayout;
          layoutCtrl.onAccessibilityAction = onAccessibilityAction;
        },
      },
      children,
    );
  },
}));
vi.mock('react-native', () => ({
  View: ({ testID, children }: { testID?: string; children?: ReactNode }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: {
    get OS() {
      return platformCtrl.os;
    },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: Children & { color?: string }) =>
    createElement('span', { 'data-color': color }, children),
}));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ children, testID, title }: Children & { testID?: string; title: string }) =>
    createElement('span', { 'data-testid': testID, 'data-native-viewer': 'true', 'data-title': title }, children),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../board-presence/BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({ name }: { name?: string | null }) => createElement('i', { 'data-avatar': name ?? '?' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: themeCtrl.scheme,
    systemColors: { label: '#000' },
    brandColors: {
      primary: '#6D28D9',
      primaryFill: '#6D28D9',
      primaryStrong: '#5B21B6',
      onPrimary: '#fff',
      onAccent: '#111',
      live: '#B45309',
      warning: '#FBBF24',
    },
  }),
}));
vi.mock('../../../theme/colors', () => ({
  withAlpha: (color: string) => color,
  wallGlowSurfaces: {
    dark: { base: '#0E0D12', label: '#FFFFFF', frost: true, border: 'rgba(255, 255, 255, 0.2)' },
    light: { base: '#F6F3FB', label: '#16111F', frost: false, border: 'rgba(0, 0, 0, 0.12)' },
  },
}));
// The glow has its own test; here only whether the button draws one, and on what.
vi.mock('../WallGlow', () => ({
  WallGlow: ({ layer }: { layer: { blobs: unknown[]; blend: string; fade: number } }) =>
    createElement('div', {
      'data-testid': 'wall-glow',
      'data-blobs': String(layer.blobs.length),
      'data-blend': layer.blend,
    }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, androidRipple: () => undefined }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.4 }));
vi.mock('../../../theme/layout', () => ({ glassSize: { inline: 44, inlinePrimary: 48 } }));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));
// The swipe (#7113): the gesture has its own test (use-wall-swipe); here only
// what the button draws from its state, and that a pan swallows the tap.
const swipeCtrl = vi.hoisted(() => ({
  frostArmed: false,
  releaseArmed: false,
  committed: false,
  panned: false,
  noteLongPress: vi.fn(),
  options: [] as { enabled: boolean; onSwipe?: () => unknown; onCancel?: () => void }[],
}));
vi.mock('../use-wall-swipe', () => ({
  useWallSwipe: (options: { enabled: boolean; onSwipe?: () => unknown; onCancel?: () => void }) => {
    swipeCtrl.options.push(options);
    return {
      gesture: {},
      progress: { value: 0 },
      opacity: { value: 1 },
      frostArmed: swipeCtrl.frostArmed,
      releaseArmed: swipeCtrl.releaseArmed,
      committed: swipeCtrl.committed,
      consumePanned: () => swipeCtrl.panned,
      noteLongPress: swipeCtrl.noteLongPress,
    };
  },
}));
vi.mock('../WallSwipeWipe', () => ({
  WallSwipeWipe: ({ layer, fill }: { layer: unknown; fill: string }) =>
    createElement('div', {
      'data-testid': 'wall-swipe-wipe',
      'data-frost': layer ? 'true' : 'false',
      'data-fill': fill,
    }),
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: Children) => createElement('div', { 'data-testid': 'gesture' }, children),
}));
// The peek's triggers (spec B3): which the button hands its hint, and the screen reader read.
const peekCtrl = vi.hoisted(() => ({
  triggers: [] as { offered: boolean; windowLive: boolean; screenReaderOn: boolean }[],
  screenReaderOn: false,
}));
vi.mock('../../../lib/wall-swipe-hint', () => ({
  useWallSwipePeek: (triggers: { offered: boolean; windowLive: boolean; screenReaderOn: boolean }) => {
    peekCtrl.triggers.push(triggers);
    return 0;
  },
}));
vi.mock('../../../hooks/use-screen-reader-enabled', () => ({ useScreenReaderEnabled: () => peekCtrl.screenReaderOn }));
// The timed drive's clock and shrinking frost run on their own
// (wall-window-clock test); here only whether the button draws them, and the
// time it says as its value.
// A store, so a test can tick the clock and see which views re-render for it.
const windowClock = vi.hoisted(() => ({ secondsLeft: 38 as number | null, listeners: new Set<() => void>() }));
vi.mock('../WallWindowClock', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    windowClock.listeners.add(listener);
    return () => {
      windowClock.listeners.delete(listener);
    };
  };
  const read = () => windowClock.secondsLeft;
  // The 10 s step's own snapshot, as the real hook's: it changes only on a step.
  const readStepped = () => {
    const seconds = windowClock.secondsLeft;
    if (seconds === null) return null;
    return seconds < 10 ? 0 : Math.floor(seconds / 10) * 10;
  };
  return {
    useWindowSecondsLeft: (step: 1 | 10) => {
      const seconds = useSyncExternalStore(subscribe, step === 1 ? read : readStepped);
      if (seconds === null) return null;
      return { secondsLeft: seconds, totalMs: 45_000 };
    },
    WallWindowDigits: ({ color }: { color: string }) =>
      createElement('span', { 'data-testid': 'window-digits', 'data-color': color }),
    // Whole outside a timed drive; there it shrinks on its own (wall-window-clock test).
    WallWindowFrost: ({ children, reduceMotion, timed }: Children & { reduceMotion: boolean; timed: boolean }) =>
      createElement(
        'div',
        { 'data-testid': 'window-frost', 'data-reduce-motion': String(reduceMotion), 'data-timed': String(timed) },
        children,
      ),
  };
});
/** The window's clock moves on: every view that reads it hears it. */
function tickWindow(secondsLeft: number) {
  windowClock.secondsLeft = secondsLeft;
  for (const listener of windowClock.listeners) listener();
}
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));

import { act } from '@testing-library/react';
import { WallControlButton } from '../WallControlButton';
import type { WallGlowInput } from '../use-wall-glow';
import { resolveWallControl, type WallControlModel, type WallControlState, type WallHolder } from '../wall-control';

afterEach(() => {
  cleanup();
  peekCtrl.triggers = [];
  peekCtrl.screenReaderOn = false;
  windowClock.secondsLeft = 38;
  swipeCtrl.frostArmed = false;
  swipeCtrl.releaseArmed = false;
  swipeCtrl.committed = false;
  swipeCtrl.panned = false;
  swipeCtrl.noteLongPress.mockClear();
  swipeCtrl.options = [];
  platformCtrl.os = 'ios';
});

type ModelOptions = {
  holder?: WallHolder;
  crewName?: string | null;
  commitLabel?: 'putOnWall' | 'setActive';
  pending?: boolean;
  writing?: boolean;
  /** A swipe from here goes up on the wall: solo by default; false in a crew (#7017). */
  navigationCommits?: boolean;
  /** The drive (#7113), and whether it is Put on board's timed drive (2.7). */
  driveMode?: 'off' | 'arming' | 'live';
  lightWindow?: boolean;
};

/** The model the player builds for one state and holder. */
function modelFor(state: WallControlState, options: ModelOptions = {}): WallControlModel {
  const { holder = null, crewName = 'Sam', commitLabel = 'putOnWall' } = options;
  const self = holder === 'self';
  return resolveWallControl({
    commitButton: state === 'put_on_wall' ? 'putOnWall' : null,
    pressAction:
      state === 'take_wall'
        ? 'takeWall'
        : state === 'release_wall'
          ? 'releaseWall'
          : state === 'connect'
            ? 'connect'
            : holder === 'crew'
              ? 'relay'
              : self
                ? 'disconnect'
                : 'noop',
    holderIsAuthoritative: holder === 'crew',
    localConnected: self && state !== 'release_wall',
    pending: options.pending ?? false,
    displayedLit: state === 'lit',
    offWall: state === null,
    wallHeldLocally: state === 'release_wall',
    holderIsSelfAccount: false,
    selfFace: { name: 'Me', avatarUrl: 'me.png' },
    crewFace: crewName === null ? null : { name: crewName, avatarUrl: null },
    confirmArmed: false,
    commitLabel,
    otherClimbLit: false,
    writing: options.writing ?? false,
    navigationCommits: options.navigationCommits ?? true,
    driveMode: options.driveMode,
    lightWindow: options.lightWindow,
  });
}

function renderButton(
  model: WallControlModel,
  extra: {
    onLongPress?: () => void;
    onDrive?: () => void;
    onSwipe?: () => 'started' | 'held_by_crew' | 'unavailable';
    compact?: boolean;
    spansRow?: boolean;
    glow?: WallGlowInput | null;
    sample?: boolean;
  } = {},
) {
  const onPress = vi.fn();
  const onLongPress = extra.onLongPress ?? vi.fn();
  const view = render(
    createElement(WallControlButton, {
      model,
      onPress,
      onLongPress,
      onDrive: extra.onDrive,
      onSwipe: extra.onSwipe,
      compact: extra.compact,
      spansRow: extra.spansRow,
      glow: extra.glow,
      sample: extra.sample,
    }),
  );
  return { ...view, onPress, onLongPress };
}

const GLOW: WallGlowInput = {
  key: 'climb-1|frames',
  holds: [
    { x: 40, y: 110, color: '#00DD00' },
    { x: 55, y: 60, color: '#4DF5FD' },
    { x: 60, y: 10, color: '#FF0000' },
  ],
  boardWidth: 100,
  boardHeight: 120,
};

/** The pill measures itself before it can lay the glow out. */
function measure(width = 360, height = 44) {
  act(() => layoutCtrl.onLayout?.({ nativeEvent: { layout: { width, height } } }));
}

const YOU = 'playView.wallControl.youHaveBoard';
const SAM = 'playView.wallControl.holderHasBoard:{"name":"Sam"}';
const PUT_ON_BOARD = 'playView.wallControl.putOnBoard';
const DRIVING = 'playView.wallControl.youAreDriving, playView.wallControl.drivingEveryClimb';

describe('WallControlButton', () => {
  // The label says what a press does (#7113); then who has the board, which the
  // face alone would leave unsaid.
  it.each([
    ['connect', null, PUT_ON_BOARD],
    ['put_on_wall', null, PUT_ON_BOARD],
    ['put_on_wall', 'self', `${PUT_ON_BOARD}, ${YOU}`],
    ['put_on_wall', 'crew', `${PUT_ON_BOARD}, ${SAM}`],
    ['dark', 'self', `${PUT_ON_BOARD}, ${YOU}`],
    // Solo with lighting on swipes: driving, so a press stops it.
    ['lit', 'self', DRIVING],
    ['crew', 'crew', `${PUT_ON_BOARD}, ${SAM}`],
    ['take_wall', null, 'ble.takeWall'],
    ['release_wall', 'self', `ble.releaseWall, ${YOU}`],
  ] as Array<[WallControlState, 'self' | 'crew' | null, string]>)(
    '%s, held by %s, reads %s',
    (state, holder, label) => {
      const { getByRole } = renderButton(modelFor(state, { holder }));
      expect(getByRole('button').getAttribute('aria-label')).toBe(label);
    },
  );

  // The bulb is the same in every state, and fills whenever this phone holds the
  // board, whatever the state (#7000, Marco's QA): "Put on the wall" on a
  // preview with the link up, and Disconnect board, fill too.
  it('shows the same bulb in every state, filled whenever you hold the board, an outline otherwise', () => {
    const cases: Array<[WallControlState, WallHolder]> = [
      ['connect', null],
      ['put_on_wall', null],
      ['put_on_wall', 'self'],
      ['put_on_wall', 'crew'],
      ['dark', 'self'],
      ['lit', 'self'],
      ['crew', 'crew'],
      ['take_wall', null],
      ['release_wall', 'self'],
    ];
    for (const [state, holder] of cases) {
      const model = modelFor(state, { holder });
      expect(model.holder).toBe(holder);
      const { container } = renderButton(model);
      expect([...container.querySelectorAll('[data-icon]')].map((node) => node.getAttribute('data-icon'))).toEqual([
        holder === 'self' ? 'lightbulb.fill' : 'lightbulb',
      ]);
      cleanup();
    }
  });

  it('shows the model’s holder face at the trailing edge, and no face with no holder', () => {
    const mine = renderButton(modelFor('lit', { holder: 'self' }));
    expect(mine.container.querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('Me');
    cleanup();
    const sams = renderButton(modelFor('crew', { holder: 'crew' }));
    expect(sams.container.querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('Sam');
    cleanup();
    const nobody = renderButton(modelFor('connect'));
    expect(nobody.container.querySelector('[data-avatar]')).toBeNull();
    expect(nobody.container.querySelector('[data-testid="play-drawer-wall-control-holder"]')).toBeNull();
  });

  it('places the live wall-state identifier on the native viewer host and preserves the button identifier', () => {
    const idle = { ...modelFor('lit', { holder: 'self' }), driving: false };
    const { getByTestId, rerender } = renderButton(idle);
    const state = getByTestId('wall-control-lit-self-idle');
    expect(state.getAttribute('data-native-viewer')).toBe('true');
    expect(getByTestId('play-drawer-wall-control').contains(state)).toBe(true);
    rerender(
      createElement(WallControlButton, { model: { ...idle, driving: true }, onPress: vi.fn(), onLongPress: vi.fn() }),
    );
    expect(getByTestId('wall-control-lit-self-driving').getAttribute('data-native-viewer')).toBe('true');
  });

  // Marco's bug: after a tap-disconnect the face stayed, read from stale presence.
  it('draws no face once the model has no holder, whatever presence says', () => {
    const afterDisconnect: WallControlModel = {
      ...modelFor('lit', { holder: 'self' }),
      holder: null,
      holderFace: null,
    };
    expect(renderButton(afterDisconnect).container.querySelector('[data-avatar]')).toBeNull();
  });

  it('says Set active for a preview no wall can light', () => {
    const { getByRole } = renderButton(modelFor('put_on_wall', { commitLabel: 'setActive' }));
    expect(getByRole('button').getAttribute('aria-label')).toBe('playView.setActive');
  });

  it('names the crew’s board when nobody is known', () => {
    const { getByRole } = renderButton(modelFor('crew', { holder: 'crew', crewName: null }));
    expect(getByRole('button').getAttribute('aria-label')).toBe(`${PUT_ON_BOARD}, playView.wallControl.crewHasBoard`);
    cleanup();
    const preview = renderButton(modelFor('put_on_wall', { holder: 'crew', crewName: null }));
    expect(preview.getByRole('button').getAttribute('aria-label')).toBe(
      `${PUT_ON_BOARD}, playView.wallControl.crewHasBoard`,
    );
  });

  it('reads as selected only when lit, and says a tap disconnects and a hold opens the controls', () => {
    const lit = renderButton(modelFor('lit', { holder: 'self', navigationCommits: false }));
    expect(lit.getByRole('button').getAttribute('aria-selected')).toBe('true');
    expect(lit.getByRole('button').getAttribute('data-hint')).toBe('playView.wallControl.litHint');
    // The hold is a named action, "Board options".
    expect(lit.getByRole('button').getAttribute('data-actions')).toBe('playView.wallControl.boardOptions');
    cleanup();
    expect(
      renderButton(modelFor('dark', { holder: 'self' }))
        .getByRole('button')
        .getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('says Disconnect board on a lit climb this phone holds', () => {
    const lit = renderButton(modelFor('lit', { holder: 'self', navigationCommits: false }));
    expect(lit.getAllByText('playView.wallControl.disconnectBoard').length).toBeGreaterThan(0);
    expect(lit.getByTestId('play-drawer-wall-control-holder')).toBeTruthy();
  });

  // The preview-first card draws the real button as a picture beside the real
  // one: a test or a Maestro `id:` selector must only ever find the real one.
  it('carries no testIDs as a picture', () => {
    const picture = renderButton(modelFor('lit', { holder: 'self' }), { sample: true });
    expect(picture.getAllByText('playView.wallControl.youAreDriving').length).toBeGreaterThan(0);
    expect(picture.container.querySelector('[data-testid^="play-drawer-wall-control"]')).toBeNull();
    expect(picture.container.querySelector('[data-testid^="wall-control-"]')).toBeNull();
  });

  it('says You are driving the wall while driving, and that a tap stops it', () => {
    const driving = renderButton(modelFor('lit', { holder: 'self' }));
    expect(driving.getAllByText('playView.wallControl.youAreDriving').length).toBeGreaterThan(0);
    expect(driving.getByRole('button').getAttribute('data-hint')).toBe('playView.wallControl.stopDrivingHint');
    expect(driving.getByTestId('play-drawer-wall-control-holder')).toBeTruthy();
  });

  it('runs the tap, and the hold only while the model offers the sheet', () => {
    const { getByRole, onPress, onLongPress } = renderButton(modelFor('lit', { holder: 'self' }));
    fireEvent.click(getByRole('button'));
    fireEvent.contextMenu(getByRole('button'));
    expect(onPress).toHaveBeenCalledOnce();
    expect(onLongPress).toHaveBeenCalledOnce();
    // A hold that fired wins the touch: the swipe ignores a drag after it.
    expect(swipeCtrl.noteLongPress).toHaveBeenCalledOnce();
    cleanup();
    const free = renderButton(modelFor('connect'));
    expect(free.getByRole('button').getAttribute('data-long-press')).toBe('false');
    expect(free.getByRole('button').getAttribute('data-actions')).toBe('');
  });

  // #7113: a screen reader can't swipe the button, so the swipe is a named action.
  it('offers Light every climb beside Board options where the model offers the swipe', () => {
    const onDrive = vi.fn();
    const onLongPress = vi.fn();
    const lit = renderButton(modelFor('lit', { holder: 'self', navigationCommits: false }), { onDrive, onLongPress });
    expect(lit.getByRole('button').getAttribute('data-actions')).toBe(
      'playView.wallControl.boardOptions|playView.wallControl.lightEveryClimb',
    );
    act(() => layoutCtrl.onAccessibilityAction?.({ nativeEvent: { actionName: 'lightEveryClimb' } }));
    expect(onDrive).toHaveBeenCalledOnce();
    expect(onLongPress).not.toHaveBeenCalled();
    // The board-sheet action keeps working beside it.
    act(() => layoutCtrl.onAccessibilityAction?.({ nativeEvent: { actionName: 'longPress' } }));
    expect(onLongPress).toHaveBeenCalledOnce();
    cleanup();
    // Already driving: no swipe, so no action.
    const driving = renderButton(modelFor('lit', { holder: 'self' }), { onDrive });
    expect(driving.getByRole('button').getAttribute('data-actions')).toBe('playView.wallControl.boardOptions');
    cleanup();
    const connect = renderButton(modelFor('connect'), { onDrive });
    expect(connect.getByRole('button').getAttribute('data-actions')).toBe('playView.wallControl.lightEveryClimb');
  });

  it('draws the same states in the narrower workout button', () => {
    const { getByRole } = renderButton(modelFor('lit', { holder: 'self' }), { compact: true });
    expect(getByRole('button').getAttribute('aria-label')).toBe(DRIVING);
    expect(getByRole('button').getAttribute('data-style')).toContain('"paddingHorizontal":8');
  });

  // #7113 PR 5: Android's edge Back took drags starting 28 dp or less from the
  // edge (Pixel 8 Pro); the full-width button ended 16 dp in.
  describe("clear of Android's edge Back", () => {
    const sideMargins = (style: string) => {
      const parsed = JSON.parse(style) as unknown[];
      const flat = parsed
        .flat(2)
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
      const left = flat.map((entry) => entry.marginLeft).find((value) => value !== undefined);
      const right = flat.map((entry) => entry.marginRight).find((value) => value !== undefined);
      return { left, right };
    };

    it('insets the full-width button 16 dp more on Android, the same on both sides', () => {
      platformCtrl.os = 'android';
      const { getByRole } = renderButton(modelFor('connect'), { spansRow: true });
      const { left, right } = sideMargins(getByRole('button').getAttribute('data-style') ?? '[]');
      expect(left).toBe(16);
      expect(right).toBe(16);
      // Symmetrical, so the button stays centred in its row.
      expect(left).toBe(right);
    });

    it('leaves iOS, and a button that does not span its row, as they were', () => {
      const ios = renderButton(modelFor('connect'), { spansRow: true });
      expect(sideMargins(ios.getByRole('button').getAttribute('data-style') ?? '[]')).toEqual({
        left: undefined,
        right: undefined,
      });
      cleanup();
      platformCtrl.os = 'android';
      const compact = renderButton(modelFor('connect'), { compact: true });
      expect(sideMargins(compact.getByRole('button').getAttribute('data-style') ?? '[]')).toEqual({
        left: undefined,
        right: undefined,
      });
    });
  });

  it('waits while a connect is in flight', () => {
    const { getByRole, onPress, container } = renderButton(modelFor('connect', { pending: true }));
    fireEvent.click(getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
  });

  // The bulb's writing spinner and last-ten-seconds ring, carried onto the button.
  it('shows the write spinner and says so, while a tap still lands', () => {
    const { getByRole, onPress, container } = renderButton(modelFor('lit', { holder: 'self', writing: true }));
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(getByRole('button').getAttribute('data-hint')).toBe('ble.writing');
    expect(getByRole('button').getAttribute('data-busy')).toBe('true');
    fireEvent.click(getByRole('button'));
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('says it is scanning while a connect is in flight', () => {
    expect(
      renderButton(modelFor('connect', { pending: true }))
        .getByRole('button')
        .getAttribute('data-hint'),
    ).toBe('ble.scanning');
  });

  // 2.7: auto-disconnect and its last-ten-seconds ring are gone.
  it('never wears a warning ring', () => {
    expect(
      renderButton(modelFor('lit', { holder: 'self' }))
        .getByRole('button')
        .getAttribute('data-style'),
    ).not.toContain('borderColor');
  });

  // Frost appears only while driving; labels and controls retain their models.
  describe('the lit glow', () => {
    afterEach(() => {
      themeCtrl.scheme = 'light';
    });

    it.each([
      ['dark', 'screen', '#0E0D12', 'rgba(255, 255, 255, 0.2)'],
      ['light', 'multiply', '#F6F3FB', 'rgba(0, 0, 0, 0.12)'],
    ] as const)(
      'glows on You are driving the wall in %s, with its own fill and a plain hairline',
      (scheme, blend, base, border) => {
        themeCtrl.scheme = scheme;
        const view = renderButton(modelFor('lit', { holder: 'self' }), { glow: GLOW });
        measure();
        const glow = view.getByTestId('wall-glow');
        expect(glow.dataset).toMatchObject({ blobs: '3', blend });
        const style = view.getByRole('button').getAttribute('data-style') ?? '';
        expect(style).toContain(`"backgroundColor":"${base}"`);
        expect(style).toContain(`"borderColor":"${border}"`);
        expect(style).toContain('"borderWidth":1');
        expect(view.getAllByText('playView.wallControl.youAreDriving').length).toBeGreaterThan(0);
      },
    );

    // #7017: the coloured look only while this climber drives the board.
    it("stays plain on a crewmate's lit board: tonal, the outline bulb, their face", () => {
      const crew = renderButton(
        { ...modelFor('crew', { holder: 'crew', navigationCommits: false }), tapAction: 'noop' },
        { glow: GLOW },
      );
      measure();
      expect(crew.queryByTestId('wall-glow')).toBeNull();
      const style = crew.getByRole('button').getAttribute('data-style') ?? '';
      expect(style).toContain('"backgroundColor":"#6D28D9"');
      expect(crew.container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('lightbulb');
      expect(crew.container.querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('Sam');
    });

    it('keeps the non-driving holder plain without changing Disconnect board, bulb or face', () => {
      const holder = renderButton(modelFor('lit', { holder: 'self', navigationCommits: false }), { glow: GLOW });
      measure();
      expect(holder.queryByTestId('wall-glow')).toBeNull();
      const style = holder.getByRole('button').getAttribute('data-style') ?? '';
      expect(style).toContain('"backgroundColor":"#6D28D9"');
      expect(holder.getAllByText('playView.wallControl.disconnectBoard').length).toBeGreaterThan(0);
      expect(holder.container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('lightbulb.fill');
      expect(holder.container.querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('Me');
    });

    it('fills a held wall with no lights amber only while your swipe moves it', () => {
      const solo = renderButton(modelFor('release_wall', { holder: 'self' }));
      expect(solo.getByRole('button').getAttribute('data-style')).toContain('"backgroundColor":"#B45309"');
      cleanup();
      const crew = renderButton(modelFor('release_wall', { holder: 'self', navigationCommits: false }));
      const style = crew.getByRole('button').getAttribute('data-style') ?? '';
      expect(style).not.toContain('#B45309');
      expect(crew.container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('lightbulb.fill');
    });

    it('glows in the narrower workout button while driving', () => {
      const compact = renderButton(modelFor('lit', { holder: 'self' }), { glow: GLOW, compact: true });
      measure(239, 44);
      expect(compact.queryByTestId('wall-glow')).not.toBeNull();
    });

    it.each(['connect', 'put_on_wall', 'dark', 'crew'] as const)(
      'keeps the physical %s action plain without driving',
      (state) => {
        const view = renderButton(
          modelFor(state, {
            holder: state === 'connect' ? null : state === 'crew' ? 'crew' : 'self',
            navigationCommits: false,
          }),
          { glow: GLOW },
        );
        measure();
        expect(view.queryByTestId('wall-glow')).toBeNull();
        expect(view.queryByText('playView.wallControl.youAreDriving')).toBeNull();
      },
    );

    it.each(['take_wall', 'release_wall'] as const)(
      'never adds frost to %s, including a moving virtual wall',
      (state) => {
        const view = renderButton(modelFor(state, { holder: state === 'release_wall' ? 'self' : null }), {
          glow: GLOW,
        });
        measure();
        expect(view.queryByTestId('wall-glow')).toBeNull();
      },
    );

    it('falls back to the flat amber with no holds, or before the pill has a size', () => {
      const empty = renderButton(modelFor('lit', { holder: 'self' }), { glow: { ...GLOW, holds: [] } });
      measure();
      expect(empty.queryByTestId('wall-glow')).toBeNull();
      expect(empty.getByRole('button').getAttribute('data-style')).toContain('"backgroundColor":"#B45309"');
      cleanup();
      const unmeasured = renderButton(modelFor('lit', { holder: 'self' }), { glow: GLOW });
      expect(unmeasured.queryByTestId('wall-glow')).toBeNull();
    });
  });

  // QA #147: on the wall per presence with no link: an amber outline, the
  // sheet's label colour, no fill, no face.
  it('outlines the wall’s climb in amber with the sheet’s label colour, and no face', () => {
    const model = resolveWallControl({
      commitButton: null,
      pressAction: 'connect',
      holderIsAuthoritative: false,
      localConnected: false,
      pending: false,
      displayedLit: true,
      offWall: false,
      displayedIsWallClimb: true,
      presenceFresh: true,
      displayedIsOwnCurrent: true,
      wallHeldLocally: false,
      holderIsSelfAccount: false,
      selfFace: { name: 'Me', avatarUrl: null },
      crewFace: { name: 'Sam', avatarUrl: null },
      confirmArmed: false,
      commitLabel: 'putOnWall',
      otherClimbLit: false,
      writing: false,
      navigationCommits: false,
    });
    const { getByRole, container } = renderButton(model);
    const style = getByRole('button').getAttribute('data-style') ?? '';
    expect(style).toContain('"backgroundColor":"transparent"');
    expect(style).toContain('"borderColor":"#B45309"');
    expect(style).toContain('"borderWidth":1.5');
    expect(getByRole('button').getAttribute('aria-label')).toBe(`${PUT_ON_BOARD}, playView.wallControl.onWall`);
    expect(getByRole('button').getAttribute('data-hint')).toBe('playView.wallControl.lightAgainHint');
    expect(container.querySelector('[data-avatar]')).toBeNull();
  });

  it('keeps the row’s height with nothing to offer', () => {
    const { container, queryByRole } = renderButton(modelFor(null));
    expect(queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-testid="play-drawer-wall-control-empty"]')).not.toBeNull();
  });

  // #7113 PR 3: swipe left to drive.
  describe('the swipe', () => {
    const onSwipe = () => 'started' as const;
    const putOnWall = () => modelFor('put_on_wall', { navigationCommits: false });

    it('shows the chevrons and offers the gesture only where the swipe is offered and wired', () => {
      const offered = renderButton(putOnWall(), { onSwipe });
      expect(offered.queryByTestId('play-drawer-wall-control-swipe-hint')).not.toBeNull();
      expect(swipeCtrl.options.at(-1)?.enabled).toBe(true);
      cleanup();
      // The flag off: the host hands no `onSwipe`, so no chevrons and no gesture.
      const flagOff = renderButton(putOnWall());
      expect(flagOff.queryByTestId('play-drawer-wall-control-swipe-hint')).toBeNull();
      expect(swipeCtrl.options.at(-1)?.enabled).toBe(false);
      expect(flagOff.getByRole('button').getAttribute('data-hint')).toBe('playView.wallControl.lightHint');
      cleanup();
      // Already driving: nothing to swipe to.
      const driving = renderButton(modelFor('lit', { holder: 'self' }), { onSwipe });
      expect(driving.queryByTestId('play-drawer-wall-control-swipe-hint')).toBeNull();
      expect(swipeCtrl.options.at(-1)?.enabled).toBe(false);
    });

    // Under VoiceOver and TalkBack a swipe moves focus: the named action
    // "Light every climb" is the way in, so the hint never mentions a swipe.
    it('leaves the spoken hint to the tap', () => {
      const { getByRole } = renderButton(modelFor('connect'), { onSwipe });
      expect(getByRole('button').getAttribute('data-hint')).toBe('playView.wallControl.connectHint');
    });

    it("offers no swipe on a crewmate's board", () => {
      const sams = renderButton(modelFor('put_on_wall', { holder: 'crew', navigationCommits: false }), { onSwipe });
      expect(sams.queryByTestId('play-drawer-wall-control-swipe-hint')).toBeNull();
      expect(swipeCtrl.options.at(-1)?.enabled).toBe(false);
    });

    it('says what letting go does once the drag is past the commit point', () => {
      swipeCtrl.frostArmed = true;
      swipeCtrl.releaseArmed = true;
      const solo = renderButton(putOnWall(), { onSwipe, glow: GLOW });
      measure();
      expect(solo.getByText('playView.wallControl.releaseToDrive')).not.toBeNull();
      expect(solo.getByTestId('wall-swipe-wipe').dataset.frost).toBe('false');
    });

    describe.each([false, true])('bokeh requires confirmed driving (compact=%s)', (compact) => {
      it.each(['peek', 'drag', 'committed-arming'] as const)(
        'keeps %s progress flat while Put on board is shown',
        (phase) => {
          swipeCtrl.frostArmed = phase !== 'committed-arming';
          swipeCtrl.committed = phase === 'committed-arming';
          const model = {
            ...putOnWall(),
            drivePhase: phase === 'committed-arming' ? ('arming' as const) : ('off' as const),
          };
          const view = renderButton(model, { onSwipe, glow: GLOW, compact });
          measure(compact ? 239 : 360, 44);
          expect(view.getAllByText(PUT_ON_BOARD).length).toBeGreaterThan(0);
          expect(view.queryByTestId('wall-glow')).toBeNull();
          expect(view.getByTestId('wall-swipe-wipe').dataset).toMatchObject({ frost: 'false', fill: '#B45309' });
          expect(view.getByTestId('play-drawer-wall-control')).toBeTruthy();
        },
      );

      it.each(['browse', 'stop'] as const)(
        'removes driving frost immediately on %s despite stale swipe progress',
        (transition) => {
          const driving = modelFor('lit', { holder: 'self' });
          const view = renderButton(driving, { onSwipe, glow: GLOW, compact });
          measure(compact ? 239 : 360, 44);
          expect(view.queryByTestId('wall-glow')).not.toBeNull();
          const button = view.getByTestId('play-drawer-wall-control');
          swipeCtrl.frostArmed = true;
          swipeCtrl.committed = true;
          const next = modelFor(transition === 'browse' ? 'put_on_wall' : 'lit', {
            holder: 'self',
            navigationCommits: false,
          });
          view.rerender(
            createElement(WallControlButton, {
              model: next,
              onPress: view.onPress,
              onLongPress: view.onLongPress,
              onSwipe,
              glow: GLOW,
              compact,
            }),
          );
          expect(view.getByTestId('play-drawer-wall-control')).toBe(button);
          expect(view.queryByTestId('wall-glow')).toBeNull();
          expect(view.getByTestId('wall-swipe-wipe').dataset.frost).toBe('false');
          expect(view.getByTestId(`wall-control-${next.state}-self-idle`)).toBeTruthy();
        },
      );
    });

    it.each(['peek', 'drag', 'committed'] as const)(
      'keeps flat progress while %s, with the drive callback wired',
      (phase) => {
        swipeCtrl.frostArmed = phase !== 'committed';
        swipeCtrl.releaseArmed = phase === 'drag';
        swipeCtrl.committed = phase === 'committed';
        const startDrive = vi.fn(() => 'started' as const);
        const view = renderButton(putOnWall(), { onSwipe: startDrive, glow: GLOW });
        measure();
        expect(view.queryAllByTestId('wall-glow')).toHaveLength(0);
        expect(view.getByTestId('wall-swipe-wipe').dataset.frost).toBe('false');
        expect(swipeCtrl.options.at(-1)?.enabled).toBe(true);
        expect(swipeCtrl.options.at(-1)?.onSwipe).toBe(startDrive);
        expect(startDrive).not.toHaveBeenCalled();
        expect(swipeCtrl.options.at(-1)?.onSwipe?.()).toBe('started');
        expect(startDrive).toHaveBeenCalledOnce();
        if (phase === 'drag') expect(view.queryByText('playView.wallControl.releaseToDrive')).not.toBeNull();
      },
    );

    it('wipes the flat amber in for a climb with no holds', () => {
      swipeCtrl.frostArmed = true;
      const view = renderButton(putOnWall(), { onSwipe, glow: { ...GLOW, holds: [] } });
      measure();
      expect(view.getByTestId('wall-swipe-wipe').dataset).toMatchObject({ frost: 'false', fill: '#B45309' });
    });

    it('mounts no frost or wipe before a drag gets going', () => {
      const view = renderButton(putOnWall(), { onSwipe, glow: GLOW });
      measure();
      expect(view.queryByTestId('wall-swipe-wipe')).toBeNull();
      expect(view.queryByTestId('wall-glow')).toBeNull();
    });

    it('drops the tap and the hold a pan ended in', () => {
      const onLongPress = vi.fn();
      const view = renderButton(modelFor('put_on_wall', { holder: 'self', navigationCommits: false }), {
        onSwipe,
        onLongPress,
      });
      swipeCtrl.panned = true;
      fireEvent.click(view.getByRole('button'));
      fireEvent.contextMenu(view.getByRole('button'));
      expect(view.onPress).not.toHaveBeenCalled();
      expect(onLongPress).not.toHaveBeenCalled();
      swipeCtrl.panned = false;
      fireEvent.click(view.getByRole('button'));
      expect(view.onPress).toHaveBeenCalledOnce();
    });
  });
});

// Put on board's timed drive (2.7, Stop driving after): the same frost and
// You are driving the wall as any drive, a clock beside the words, and the
// frost shrinking as the time runs out.
describe('WallControlButton: Put on board’s timed drive', () => {
  const windowModel = () => modelFor('lit', { holder: 'self', driveMode: 'live', lightWindow: true });
  const DRIVING_LABEL = 'playView.wallControl.youAreDriving';

  it('reads You are driving the wall, the clock beside it, the time left as its value', () => {
    const view = renderButton(windowModel(), { onSwipe: () => 'started' });
    const button = view.getByRole('button');
    // The accessible name is the visible words alone, so "Tap You are driving the wall" works by voice.
    expect(button.getAttribute('aria-label')).toBe(DRIVING_LABEL);
    expect(button.getAttribute('data-value')).toBe('playView.wallControl.stopsInSeconds:{"count":30}');
    expect(button.getAttribute('data-hint')).toBe('playView.wallControl.stopDrivingHint');
    expect(view.getAllByText(DRIVING_LABEL).length).toBeGreaterThan(0);
    expect(view.getByTestId('window-digits')).not.toBeNull();
  });

  // W3: the value steps every 10 s. It lives on a leaf around the pressable,
  // so the pill (its row, frost and swipe) never re-renders for it.
  it('steps its value on a leaf: the pill itself never re-renders for the clock', () => {
    const view = renderButton(windowModel(), { onSwipe: () => 'started' });
    const pillRenders = swipeCtrl.options.length;
    act(() => tickWindow(28));
    expect(view.getByRole('button').getAttribute('data-value')).toBe(
      'playView.wallControl.stopsInSeconds:{"count":20}',
    );
    act(() => tickWindow(7));
    expect(view.getByRole('button').getAttribute('data-value')).toBe('playView.wallControl.stopsInUnderTen');
    expect(swipeCtrl.options.length).toBe(pillRenders);
  });

  // Spec B3: the peek waits for the timed drive, the moment the swipe is news.
  it('hands the swipe peek the timed drive and the screen reader', () => {
    peekCtrl.screenReaderOn = true;
    renderButton(windowModel(), { onSwipe: () => 'started' });
    expect(peekCtrl.triggers.at(-1)).toEqual({ offered: true, windowLive: true, screenReaderOn: true });
    cleanup();
    peekCtrl.screenReaderOn = false;
    renderButton(modelFor('lit', { holder: 'self', navigationCommits: false }));
    expect(peekCtrl.triggers.at(-1)).toEqual({ offered: false, windowLive: false, screenReaderOn: false });
  });

  // Spec B3: the Large Content Viewer shows the full label, and in a timed
  // drive the time left is part of it. The clock ticks on the viewer's own leaf.
  it('shows the time left in the Large Content Viewer, ticking on its own leaf', () => {
    windowClock.secondsLeft = 38;
    const view = renderButton(windowModel(), { onSwipe: () => 'started' });
    const viewerTitle = () => view.container.querySelector('[data-native-viewer]')?.getAttribute('data-title');
    expect(viewerTitle()).toBe(`${DRIVING_LABEL} · 0:38`);
    const pillRenders = swipeCtrl.options.length;
    act(() => tickWindow(37));
    expect(viewerTitle()).toBe(`${DRIVING_LABEL} · 0:37`);
    expect(swipeCtrl.options.length).toBe(pillRenders);
    cleanup();
    const outside = renderButton(modelFor('lit', { holder: 'self', navigationCommits: false }));
    expect(outside.container.querySelector('[data-native-viewer]')?.getAttribute('data-title')).not.toContain('0:');
  });

  // The value steps every 10 s (`useWindowSecondsLeft(10)`): over the ten
  // 1 Hz ticks from 0:39 to 0:30 the pressable never re-renders, then once at 0:29.
  it('re-renders its pressable only on the 10 s step, never on the 1 Hz clock', () => {
    windowClock.secondsLeft = 39;
    const view = renderButton(windowModel(), { onSwipe: () => 'started' });
    const before = pressableCtrl.renders;
    for (let seconds = 38; seconds >= 30; seconds -= 1) act(() => tickWindow(seconds));
    expect(pressableCtrl.renders).toBe(before);
    act(() => tickWindow(29));
    expect(pressableCtrl.renders).toBe(before + 1);
    expect(view.getByRole('button').getAttribute('data-value')).toBe(
      'playView.wallControl.stopsInSeconds:{"count":20}',
    );
  });

  it('says under ten seconds without a count', () => {
    windowClock.secondsLeft = 7;
    const view = renderButton(windowModel());
    expect(view.getByRole('button').getAttribute('data-value')).toBe('playView.wallControl.stopsInUnderTen');
  });

  it('wears the frost a swipe drive wears, inside the shrinking frame, with no chevrons', () => {
    const view = renderButton(windowModel(), { glow: GLOW, onSwipe: () => 'started' });
    measure();
    const frost = view.getByTestId('window-frost');
    expect(frost.dataset.reduceMotion).toBe('false');
    // The timed drive's frost is the one that shrinks.
    expect(frost.dataset.timed).toBe('true');
    // The glow is the frost, and it is the frame's to shrink.
    expect(frost.contains(view.getByTestId('wall-glow'))).toBe(true);
    const style = view.getByRole('button').getAttribute('data-style') ?? '';
    // The pill under it is the frost's own surface, so the label reads as it shrinks.
    expect(style).toContain('"backgroundColor":"#F6F3FB"');
    expect(view.queryByTestId('play-drawer-wall-control-swipe-hint')).toBeNull();
    expect(view.getByTestId('wall-control-lit-self-driving')).not.toBeNull();
  });

  it('shrinks the flat amber where there are no holds to frost, over a pill its label reads on', () => {
    for (const [scheme, track, label] of [
      ['light', '#0E0D12', '#fff'],
      ['dark', '#F6F3FB', '#111'],
    ] as const) {
      themeCtrl.scheme = scheme;
      const view = renderButton(windowModel(), { onSwipe: () => 'started' });
      measure();
      const frost = view.getByTestId('window-frost');
      expect(frost.querySelector('div')).not.toBeNull();
      const style = view.getByRole('button').getAttribute('data-style') ?? '';
      expect(style).toContain(`"backgroundColor":"${track}"`);
      expect(view.getAllByText(DRIVING_LABEL)[0].getAttribute('data-color')).toBe(label);
      cleanup();
    }
    themeCtrl.scheme = 'light';
  });

  // An open-ended drive draws the same frame, whole: a timed drive turning
  // open-ended (a swipe) keeps the glow mounted rather than starting it again.
  // The preview-first card's picture (driving, no window) stays whole while a
  // real timed drive shrinks the player's own button beside it.
  it('keeps the frost whole on a drive with no clock, a picture of one included', () => {
    const sample = renderButton(modelFor('lit', { holder: 'self', driveMode: 'live' }), { glow: GLOW, sample: true });
    measure();
    expect(sample.getByTestId('window-frost').dataset.timed).toBe('false');
  });

  it('keeps the frost in the same frame when the drive turns open-ended, with no clock', () => {
    const handlers = { onPress: vi.fn(), onLongPress: vi.fn(), onSwipe: () => 'started' as const, glow: GLOW };
    const view = render(createElement(WallControlButton, { model: windowModel(), ...handlers }));
    measure();
    const glow = view.getByTestId('wall-glow');
    view.rerender(
      createElement(WallControlButton, {
        model: modelFor('lit', { holder: 'self', driveMode: 'live', lightWindow: false }),
        ...handlers,
      }),
    );
    expect(view.getByTestId('wall-glow')).toBe(glow);
    expect(view.queryByTestId('window-digits')).toBeNull();
    expect(view.getByRole('button').getAttribute('data-value')).toBeNull();
  });

  // The swipe still makes a timed drive open-ended, so its wipe draws over the frost.
  it('draws the swipe’s wipe over a timed drive, and its Let go label', () => {
    swipeCtrl.frostArmed = true;
    swipeCtrl.releaseArmed = true;
    const view = renderButton(windowModel(), { glow: GLOW, onSwipe: () => 'started' });
    measure();
    expect(view.queryByTestId('wall-swipe-wipe')).not.toBeNull();
    expect(view.getAllByText('playView.wallControl.releaseToDrive').length).toBeGreaterThan(0);
    cleanup();
    // An open-ended drive has nothing to start: no wipe.
    const driving = renderButton(modelFor('lit', { holder: 'self', driveMode: 'live' }), {
      glow: GLOW,
      onSwipe: () => 'started',
    });
    measure();
    expect(driving.queryByTestId('wall-swipe-wipe')).toBeNull();
  });

  it('draws no clock or value outside a timed drive', () => {
    windowClock.secondsLeft = 38;
    const view = renderButton(modelFor('lit', { holder: 'self', navigationCommits: false }));
    measure();
    expect(view.queryByTestId('window-digits')).toBeNull();
    expect(view.queryByTestId('window-frost')).toBeNull();
    expect(view.getByRole('button').getAttribute('data-value')).toBeNull();
  });

  // Spec B2: #6D28D9 measured 4.54:1 on the Material light ground, under the 4.6:1 rule.
  it('takes the deeper violet for the tonal label in light', () => {
    const view = renderButton(modelFor('put_on_wall', { holder: 'self' }));
    const label = view.getAllByText(/playView\.wallControl\.putOnBoard/)[0];
    expect(label.getAttribute('data-color')).toBe('#5B21B6');
  });
});
