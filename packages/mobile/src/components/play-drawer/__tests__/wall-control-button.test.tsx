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
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    onLayout,
    children,
    onPress,
    onLongPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
    accessibilityActions,
    onAccessibilityAction,
    testID,
    style,
  }: Children & {
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
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        onContextMenu: onLongPress,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
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
    ),
}));
vi.mock('react-native', () => ({
  View: ({ testID, children }: { testID?: string; children?: ReactNode }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: { OS: 'ios' },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ children }: Children) => createElement('span', null, children),
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
vi.mock('../../../lib/wall-swipe-hint', () => ({ useWallSwipePeek: () => 0 }));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));

import { act } from '@testing-library/react';
import { WallControlButton } from '../WallControlButton';
import type { WallGlowInput } from '../use-wall-glow';
import { resolveWallControl, type WallControlModel, type WallControlState, type WallHolder } from '../wall-control';

afterEach(() => {
  cleanup();
  swipeCtrl.frostArmed = false;
  swipeCtrl.releaseArmed = false;
  swipeCtrl.committed = false;
  swipeCtrl.panned = false;
  swipeCtrl.noteLongPress.mockClear();
  swipeCtrl.options = [];
});

type ModelOptions = {
  holder?: WallHolder;
  crewName?: string | null;
  commitLabel?: 'putOnWall' | 'setActive';
  pending?: boolean;
  writing?: boolean;
  autoDisconnectWarning?: boolean;
  /** A swipe from here goes up on the wall: solo by default; false in a crew (#7017). */
  navigationCommits?: boolean;
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
    autoDisconnectWarning: options.autoDisconnectWarning ?? false,
    navigationCommits: options.navigationCommits ?? true,
  });
}

function renderButton(
  model: WallControlModel,
  extra: {
    onLongPress?: () => void;
    onDrive?: () => void;
    onSwipe?: () => 'started' | 'needs_handoff' | 'unavailable';
    compact?: boolean;
    glow?: WallGlowInput | null;
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
      glow: extra.glow,
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

  it('wears the amber ring in auto-disconnect’s last ten seconds', () => {
    const warned = renderButton(modelFor('lit', { holder: 'self', autoDisconnectWarning: true }))
      .getByRole('button')
      .getAttribute('data-style');
    expect(warned).toContain('"borderColor":"#FBBF24"');
    cleanup();
    expect(
      renderButton(modelFor('lit', { holder: 'self' }))
        .getByRole('button')
        .getAttribute('data-style'),
    ).not.toContain('borderColor');
  });

  // F1b: the climb's holds glow in the lit button; every other state stays flat.
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
      const crew = renderButton(modelFor('crew', { holder: 'crew', navigationCommits: false }), { glow: GLOW });
      measure();
      expect(crew.queryByTestId('wall-glow')).toBeNull();
      const style = crew.getByRole('button').getAttribute('data-style') ?? '';
      expect(style).toContain('"backgroundColor":"#6D28D9"');
      expect(crew.container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('lightbulb');
      expect(crew.container.querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('Sam');
    });

    it('keeps the crew holder’s Disconnect board, filled bulb and face on the plain look, no frost', () => {
      const holder = renderButton(modelFor('lit', { holder: 'self', navigationCommits: false }), { glow: GLOW });
      measure();
      expect(holder.queryByTestId('wall-glow')).toBeNull();
      const style = holder.getByRole('button').getAttribute('data-style') ?? '';
      expect(style).toContain('"backgroundColor":"#6D28D9"');
      expect(style).not.toContain('#B45309');
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

    it.each(['connect', 'put_on_wall', 'dark'] as const)('stays flat on %s, even if handed holds', (state) => {
      const view = renderButton(modelFor(state, { holder: state === 'connect' ? null : 'self' }), { glow: GLOW });
      measure();
      expect(view.queryByTestId('wall-glow')).toBeNull();
    });

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
      autoDisconnectWarning: false,
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

    it("offers no swipe on a crewmate's board until the hand-off ships", () => {
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
      expect(solo.getByTestId('wall-swipe-wipe').dataset.frost).toBe('true');
    });

    it('wipes the flat amber in for a climb with no holds', () => {
      swipeCtrl.frostArmed = true;
      const view = renderButton(putOnWall(), { onSwipe, glow: { ...GLOW, holds: [] } });
      measure();
      expect(view.getByTestId('wall-swipe-wipe').dataset).toMatchObject({ frost: 'false', fill: '#B45309' });
    });

    it('mounts no wipe before a drag gets going', () => {
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
