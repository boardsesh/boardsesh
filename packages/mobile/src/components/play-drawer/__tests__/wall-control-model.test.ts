import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  EMPTY_WALL_CONTROL,
  isHolderSelfAccount,
  resolveBoardSheetStatus,
  resolveWallControl,
  type WallControlInput,
  type WallControlModel,
} from '../wall-control';
import { wallControlText } from '../wall-control-text';

// The one model behind every view of the board control (#7000): the wall
// button, the bulb and the open Duo's bar bulb draw it and nothing else.

const ME = { name: 'Me', avatarUrl: 'me.png' };
const SAM = { name: 'Sam', avatarUrl: 'sam.png' };

/** No board linked, nothing in flight, nobody else holding it. */
const FREE: WallControlInput = {
  commitButton: null,
  pressAction: 'connect',
  holderIsAuthoritative: false,
  localConnected: false,
  pending: false,
  displayedLit: false,
  offWall: false,
  wallHeldLocally: false,
  holderIsSelfAccount: false,
  selfFace: ME,
  crewFace: null,
  confirmArmed: false,
  commitLabel: 'putOnWall',
  otherClimbLit: false,
  writing: false,
  // Solo with lighting on swipes: a swipe from here goes up on the wall.
  navigationCommits: true,
};
const MINE: Partial<WallControlInput> = { localConnected: true, pressAction: 'disconnect' };
const SAMS: Partial<WallControlInput> = { holderIsAuthoritative: true, pressAction: 'relay', crewFace: SAM };

type Row = [
  string,
  Partial<WallControlInput>,
  {
    state: string | null;
    holder: string | null;
    tapAction: string;
    longPress: string | null;
    labelKey: string | null;
    a11yValueKey: string | null;
    a11yHintKey: string | null;
    look: string;
    swipeAction: string | null;
  },
];

const rows: Row[] = [
  [
    'no board',
    {},
    {
      state: 'connect',
      holder: null,
      tapAction: 'connect',
      longPress: null,
      labelKey: 'putOnBoard',
      a11yValueKey: null,
      a11yHintKey: 'connectHint',
      look: 'off',
      swipeAction: 'drive',
    },
  ],
  [
    'a preview, no board',
    { commitButton: 'putOnWall' },
    {
      state: 'put_on_wall',
      holder: null,
      tapAction: 'put_on_wall',
      longPress: null,
      labelKey: 'putOnBoard',
      a11yValueKey: null,
      a11yHintKey: 'lightHint',
      look: 'off',
      swipeAction: 'drive',
    },
  ],
  [
    'a preview where no wall is reachable',
    { commitButton: 'putOnWall', commitLabel: 'setActive', pressAction: 'noop' },
    {
      state: 'put_on_wall',
      holder: null,
      tapAction: 'put_on_wall',
      longPress: null,
      labelKey: 'setActive',
      a11yValueKey: null,
      a11yHintKey: 'lightHint',
      look: 'off',
      swipeAction: null,
    },
  ],
  [
    'lit, this phone holds it, solo with lighting on swipes: driving',
    { ...MINE, displayedLit: true },
    {
      state: 'lit',
      holder: 'self',
      tapAction: 'stop_driving',
      longPress: 'sheet',
      labelKey: 'youAreDriving',
      a11yValueKey: 'drivingEveryClimb',
      a11yHintKey: 'stopDrivingHint',
      look: 'lit',
      swipeAction: null,
    },
  ],
  [
    'lit, this phone holds it, not driving',
    { ...MINE, displayedLit: true, navigationCommits: false },
    {
      state: 'lit',
      holder: 'self',
      tapAction: 'disconnect',
      longPress: 'sheet',
      labelKey: 'disconnectBoard',
      a11yValueKey: 'youHaveBoardLit',
      a11yHintKey: 'litHint',
      look: 'lit',
      swipeAction: 'drive',
    },
  ],
  [
    'linked, this climb dark',
    MINE,
    {
      state: 'dark',
      holder: 'self',
      tapAction: 'relight',
      longPress: 'sheet',
      labelKey: 'putOnBoard',
      a11yValueKey: 'youHaveBoard',
      a11yHintKey: 'lightHint',
      look: 'lit',
      swipeAction: 'drive',
    },
  ],
  [
    'a preview on your board',
    { ...MINE, commitButton: 'putOnWall' },
    {
      state: 'put_on_wall',
      holder: 'self',
      tapAction: 'put_on_wall',
      longPress: 'sheet',
      labelKey: 'putOnBoard',
      a11yValueKey: 'youHaveBoard',
      a11yHintKey: 'lightHint',
      look: 'lit',
      swipeAction: 'drive',
    },
  ],
  [
    "Sam's board, lit",
    { ...SAMS, displayedLit: true },
    {
      state: 'crew',
      holder: 'crew',
      tapAction: 'relay',
      longPress: null,
      labelKey: 'putOnBoard',
      a11yValueKey: 'holderHasBoard',
      a11yHintKey: 'relayHint',
      look: 'ready',
      swipeAction: null,
    },
  ],
  // #7015: Sam turned all the lights off; this phone hears it through presence.
  [
    "Sam's board, lights turned off",
    SAMS,
    {
      state: 'crew',
      holder: 'crew',
      tapAction: 'relay',
      longPress: null,
      labelKey: 'putOnBoard',
      a11yValueKey: 'holderHasBoard',
      a11yHintKey: 'relayHint',
      look: 'ready',
      swipeAction: null,
    },
  ],
  [
    "a preview on Sam's board",
    { ...SAMS, commitButton: 'putOnWall' },
    {
      state: 'put_on_wall',
      holder: 'crew',
      tapAction: 'put_on_wall',
      longPress: null,
      labelKey: 'putOnBoard',
      a11yValueKey: 'holderHasBoard',
      a11yHintKey: 'lightHint',
      look: 'off',
      // Sam's phone holds his board: no swipe on it, by design.
      swipeAction: null,
    },
  ],
  [
    'the busy-wall question up',
    { ...MINE, displayedLit: true, confirmArmed: true },
    {
      state: 'lit',
      holder: 'self',
      tapAction: 'noop',
      longPress: 'sheet',
      labelKey: 'youAreDriving',
      a11yValueKey: 'drivingEveryClimb',
      a11yHintKey: null,
      look: 'lit',
      swipeAction: null,
    },
  ],
  [
    'a connect in flight',
    { pending: true, pressAction: 'noop' },
    {
      state: 'connect',
      holder: null,
      tapAction: 'noop',
      longPress: null,
      labelKey: 'putOnBoard',
      a11yValueKey: null,
      a11yHintKey: null,
      look: 'off',
      swipeAction: null,
    },
  ],
  [
    "a climb the wall can't light (another board, spray, no lights)",
    { ...MINE, offWall: true },
    {
      state: null,
      holder: 'self',
      tapAction: 'noop',
      longPress: 'sheet',
      labelKey: null,
      a11yValueKey: null,
      a11yHintKey: null,
      look: 'lit',
      swipeAction: null,
    },
  ],
  [
    'a wall with no lights, free',
    { pressAction: 'takeWall', offWall: true },
    {
      state: 'take_wall',
      holder: null,
      tapAction: 'take_wall',
      longPress: null,
      labelKey: 'takeWall',
      a11yValueKey: null,
      a11yHintKey: null,
      look: 'off',
      swipeAction: null,
    },
  ],
  [
    'a wall with no lights, yours',
    { pressAction: 'releaseWall', wallHeldLocally: true, offWall: true },
    {
      state: 'release_wall',
      holder: 'self',
      tapAction: 'release_wall',
      longPress: null,
      labelKey: 'releaseWall',
      a11yValueKey: 'youHaveBoard',
      a11yHintKey: null,
      look: 'lit',
      swipeAction: null,
    },
  ],
  // Marco's bug: a tap-disconnect left the face up, read from presence.
  [
    'just after a tap-disconnect, presence still naming a holder',
    { crewFace: SAM, pressAction: 'connect' },
    {
      state: 'connect',
      holder: null,
      tapAction: 'connect',
      longPress: null,
      labelKey: 'putOnBoard',
      a11yValueKey: null,
      a11yHintKey: 'connectHint',
      look: 'off',
      swipeAction: 'drive',
    },
  ],
  [
    // This account's link on another device (a stale record of this phone is never authoritative).
    'presence names this climber, with no link',
    { holderIsAuthoritative: true, holderIsSelfAccount: true, crewFace: ME, pressAction: 'connect' },
    {
      state: 'crew',
      holder: null,
      tapAction: 'noop',
      longPress: null,
      labelKey: 'onOtherPhone',
      a11yValueKey: null,
      a11yHintKey: null,
      look: 'ready',
      swipeAction: null,
    },
  ],
];

describe('resolveWallControl', () => {
  it.each(rows)('%s', (_case, input, expected) => {
    expect(resolveWallControl({ ...FREE, ...input })).toMatchObject(expected);
  });

  it('puts a face up only with a live link: its own climber, or the crewmate who holds it', () => {
    expect(resolveWallControl({ ...FREE, ...MINE }).holderFace).toEqual(ME);
    expect(resolveWallControl({ ...FREE, ...SAMS }).holderFace).toEqual(SAM);
    expect(resolveWallControl({ ...FREE, crewFace: SAM }).holderFace).toBeNull();
    expect(
      resolveWallControl({ ...FREE, holderIsAuthoritative: true, holderIsSelfAccount: true, crewFace: ME }).holderFace,
    ).toBeNull();
  });

  it('names only a crewmate; this climber is "You"', () => {
    expect(resolveWallControl({ ...FREE, ...SAMS }).holderName).toBe('Sam');
    expect(resolveWallControl({ ...FREE, ...MINE }).holderName).toBeNull();
    expect(resolveWallControl({ ...FREE, ...SAMS, crewFace: null })).toMatchObject({
      labelKey: 'putOnBoard',
      a11yValueKey: 'crewHasBoard',
      a11yHintKey: 'relayHintCrew',
    });
  });

  it("gives the bulb a value: lit on your board, Sam's board, another climb up, or off", () => {
    expect(resolveWallControl({ ...FREE, ...MINE, displayedLit: true }).bulbValueKey).toBe('youHaveBoardLit');
    expect(resolveWallControl({ ...FREE, ...SAMS }).bulbValueKey).toBe('onBoard');
    expect(resolveWallControl({ ...FREE, ...MINE, otherClimbLit: true }).bulbValueKey).toBe('valueOtherClimb');
    expect(resolveWallControl({ ...FREE, otherClimbLit: true }).bulbValueKey).toBe('valueOff');
  });

  it('carries the write to every view', () => {
    expect(resolveWallControl({ ...FREE, ...MINE, writing: true })).toMatchObject({ writing: true });
  });
});

describe('wallControlText', () => {
  const t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key) as unknown as TFunction;

  it('says Disconnect board, and to a screen reader that the climb is lit, with the tap and the hold', () => {
    const text = wallControlText(
      resolveWallControl({ ...FREE, ...MINE, displayedLit: true, navigationCommits: false }),
      t,
      t,
    );
    expect(text).toMatchObject({
      label: 'playView.wallControl.disconnectBoard',
      accessibilityLabel: 'playView.wallControl.disconnectBoard, playView.wallControl.youHaveBoardLit',
      accessibilityHint: 'playView.wallControl.litHint',
      bulbAccessibilityLabel: 'playView.wallControl.bulbAria',
      bulbValue: 'playView.wallControl.youHaveBoardLit',
      longPressActionLabel: 'playView.wallControl.boardOptions',
    });
  });

  // #7113: the label says what a press does; who has the board rides after it.
  it('says the label, then who has the board', () => {
    const text = wallControlText(resolveWallControl({ ...FREE, ...SAMS }), t, t);
    expect(text.label).toBe('playView.wallControl.putOnBoard');
    expect(text.accessibilityLabel).toBe(
      'playView.wallControl.putOnBoard, playView.wallControl.holderHasBoard:{"name":"Sam"}',
    );
    expect(text.accessibilityHint).toBe('playView.wallControl.relayHint:{"name":"Sam"}');
  });

  // The accessible name is the visible words only; the time is the button's value.
  it("says You are driving the wall alone, and how to stop it, in Put on board's timed drive", () => {
    const text = wallControlText(
      resolveWallControl({ ...FREE, ...MINE, displayedLit: true, driveMode: 'live', lightWindow: true }),
      t,
      t,
    );
    expect(text).toMatchObject({
      label: 'playView.wallControl.youAreDriving',
      accessibilityLabel: 'playView.wallControl.youAreDriving',
      // One hint for every view: the first-row bulb stops the drive too (owner, 2026-11-03).
      accessibilityHint: 'playView.wallControl.stopDrivingHint',
      driveActionLabel: 'playView.wallControl.lightEveryClimb',
    });
  });

  it('says scanning while a connect is in flight, and writing while a climb goes up', () => {
    expect(wallControlText(resolveWallControl({ ...FREE, pending: true }), t, t).accessibilityHint).toBe(
      'ble.scanning',
    );
    expect(wallControlText(resolveWallControl({ ...FREE, ...MINE, writing: true }), t, t).accessibilityHint).toBe(
      'ble.writing',
    );
  });
});

// #7076: a gym with a Kilter and a MoonBoard, one mixed queue. The MoonBoard
// can't draw the Kilter climb on screen, but there is somewhere to go.
describe('resolveWallControl: a climb on another board at this gym', () => {
  const KILTER_CLIMB: Partial<WallControlInput> = { offWall: true, gymBoardName: 'Kilter' };
  const MOVE = {
    state: 'move_to_board',
    tapAction: 'move_to_board',
    labelKey: 'putOnGymBoard',
    a11yHintKey: 'moveToGymBoardHint',
    gymBoardName: 'Kilter',
  };

  it('offers Put on Kilter while linked to the MoonBoard', () => {
    expect(resolveWallControl({ ...FREE, ...MINE, ...KILTER_CLIMB })).toMatchObject({
      ...MOVE,
      holder: 'self',
      longPress: 'sheet',
    });
  });

  it('offers Put on Kilter with no board linked', () => {
    expect(resolveWallControl({ ...FREE, ...KILTER_CLIMB })).toMatchObject({ ...MOVE, holder: null, longPress: null });
  });

  it("offers Put on Kilter over a crew preview's Put on the wall", () => {
    expect(resolveWallControl({ ...FREE, ...SAMS, ...KILTER_CLIMB, commitButton: 'putOnWall' })).toMatchObject(MOVE);
    expect(resolveWallControl({ ...FREE, ...MINE, ...KILTER_CLIMB, commitButton: 'putOnWall' })).toMatchObject(MOVE);
  });

  it('offers nothing for a climb no board at this gym draws, as before', () => {
    expect(resolveWallControl({ ...FREE, ...MINE, offWall: true, gymBoardName: null })).toMatchObject({
      state: null,
      tapAction: 'noop',
      labelKey: null,
      gymBoardName: null,
    });
  });

  it('waits on the busy-wall question like every other tap', () => {
    expect(resolveWallControl({ ...FREE, ...MINE, ...KILTER_CLIMB, confirmArmed: true })).toMatchObject({
      state: 'move_to_board',
      tapAction: 'noop',
      a11yHintKey: null,
    });
  });

  // The presence block only covers a climb this wall draws, so it can't really
  // meet a gym board name; if it does, On the wall still wins.
  it('loses to fresh presence on the wall climb with no link', () => {
    const model = resolveWallControl({
      ...FREE,
      displayedIsWallClimb: true,
      presenceFresh: true,
      gymBoardName: 'Kilter',
    });
    expect(model).toMatchObject({ state: 'on_wall_unlinked', gymBoardName: null });
  });

  // Marco: a crewmate keeps their own board. When the crew session is on the
  // Kilter (a crewmate moved it there and lights it), this phone never takes it.
  describe("on the crew's board", () => {
    const CREW_KILTER: Partial<WallControlInput> = { ...KILTER_CLIMB, crewGymBoard: true };

    it("reads the crew's board for the crew's own climb, and a tap does nothing", () => {
      expect(resolveWallControl({ ...FREE, ...CREW_KILTER })).toMatchObject({
        state: 'crew',
        holder: 'crew',
        holderName: null,
        holderFace: null,
        tapAction: 'noop',
        labelKey: 'onCrewBoard',
        gymBoardName: null,
      });
    });

    it('relays a preview to the crew instead of Put on Kilter', () => {
      expect(resolveWallControl({ ...FREE, ...CREW_KILTER, commitButton: 'putOnWall' })).toMatchObject({
        state: 'put_on_wall',
        holder: 'crew',
        tapAction: 'relay',
        labelKey: 'putOnBoard',
        a11yValueKey: 'crewHasBoard',
        a11yHintKey: 'relayHintCrew',
      });
    });

    it("is the crew's even while this phone holds its own board's link", () => {
      expect(resolveWallControl({ ...FREE, ...MINE, ...CREW_KILTER })).toMatchObject({
        state: 'crew',
        holder: 'crew',
        tapAction: 'noop',
        longPress: null,
      });
    });

    it('ignores the crew session when the climb is on no other gym board', () => {
      expect(resolveWallControl({ ...FREE, ...MINE, offWall: true, crewGymBoard: true })).toMatchObject({
        state: null,
      });
    });

    it('waits on the busy-wall question', () => {
      expect(
        resolveWallControl({ ...FREE, ...CREW_KILTER, commitButton: 'putOnWall', confirmArmed: true }),
      ).toMatchObject({ tapAction: 'noop' });
    });
  });

  it('carries no board name in any other state', () => {
    expect(resolveWallControl({ ...FREE, ...MINE, displayedLit: true }).gymBoardName).toBeNull();
  });

  it('says Put on {board}, and tells a screen reader it moves there', () => {
    const t = ((key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key) as unknown as TFunction;
    const text = wallControlText(resolveWallControl({ ...FREE, ...MINE, ...KILTER_CLIMB }), t, t);
    expect(text.label).toBe('playView.wallControl.putOnGymBoard:{"board":"Kilter"}');
    expect(text.accessibilityHint).toBe('playView.wallControl.moveToGymBoardHint:{"board":"Kilter"}');
    expect(text.accessibilityLabel).toContain('playView.wallControl.putOnGymBoard:{"board":"Kilter"}');
  });
});

// QA #147: no live link, on the climb presence says is on the wall. Trusted for
// an hour (Aurora and MoonBoard boxes keep their LEDs after a disconnect).
describe('resolveWallControl: presence freshness', () => {
  const WALL: Partial<WallControlInput> = { displayedIsWallClimb: true };
  type Row = [string, Partial<WallControlInput>, string | null, string, string];
  // [case, input, state, tap, look]
  const rows: Row[] = [
    [
      'fresh, no link, your own climb',
      { ...WALL, presenceFresh: true, displayedIsOwnCurrent: true },
      'on_wall_unlinked',
      'relight',
      'ready',
    ],
    [
      'fresh, no link, a preview',
      { ...WALL, presenceFresh: true, commitButton: 'putOnWall' },
      'on_wall_unlinked',
      'put_on_wall',
      'ready',
    ],
    ['stale, no link, your own climb', { ...WALL, displayedIsOwnCurrent: true }, 'connect', 'connect', 'off'],
    [
      'stale, no link, a preview: never Put on the wall',
      { ...WALL, commitButton: 'putOnWall' },
      'connect',
      'connect',
      'off',
    ],
    [
      'fresh, your link, lit',
      { ...WALL, ...MINE, presenceFresh: true, displayedLit: true },
      'lit',
      'stop_driving',
      'lit',
    ],
    ['stale, your link, lit', { ...WALL, ...MINE, displayedLit: true }, 'lit', 'stop_driving', 'lit'],
    [
      'stale, your link, lit, not driving',
      { ...WALL, ...MINE, displayedLit: true, navigationCommits: false },
      'lit',
      'disconnect',
      'lit',
    ],
    ["fresh, Sam's link", { ...WALL, ...SAMS, presenceFresh: true, displayedLit: true }, 'crew', 'relay', 'ready'],
    ["stale, Sam's link", { ...WALL, ...SAMS, displayedLit: true }, 'crew', 'relay', 'ready'],
    [
      'fresh, no link, not the wall’s climb: as before',
      { presenceFresh: true, commitButton: 'putOnWall' },
      'put_on_wall',
      'put_on_wall',
      'off',
    ],
  ];

  it.each(rows)('%s', (_case, input, state, tapAction, look) => {
    expect(resolveWallControl({ ...FREE, ...input })).toMatchObject({ state, tapAction, look });
  });

  it('says Put on board, outlined, with no face, and tells a screen reader it is on the wall and a tap lights it again', () => {
    const model = resolveWallControl({
      ...FREE,
      ...WALL,
      presenceFresh: true,
      displayedIsOwnCurrent: true,
      crewFace: SAM,
    });
    expect(model).toMatchObject({
      labelKey: 'putOnBoard',
      a11yValueKey: 'onWall',
      a11yHintKey: 'lightAgainHint',
      holder: null,
      holderFace: null,
      selected: false,
      longPress: null,
      bulbValueKey: 'onWall',
    });
  });

  // The invariant over every combination: without a live link nothing claims
  // "you have the board", the wall's climb is never "Put on the wall", and
  // fresh presence on it always says On the wall.
  it('holds over every combination of link, freshness, wall climb, preview and pending', () => {
    let combinations = 0;
    const pressActions = ['connect', 'disconnect', 'relay', 'noop', 'takeWall', 'releaseWall'] as const;
    for (const localConnected of [true, false]) {
      for (const holderIsAuthoritative of [true, false]) {
        for (const presenceFresh of [true, false]) {
          for (const displayedIsWallClimb of [true, false]) {
            for (const commitButton of ['putOnWall', 'confirm', null] as const) {
              for (const displayedIsOwnCurrent of [true, false]) {
                for (const pending of [true, false]) {
                  for (const offWall of [true, false]) {
                    for (const pressAction of pressActions) {
                      combinations += 1;
                      const model = resolveWallControl({
                        ...FREE,
                        localConnected,
                        holderIsAuthoritative,
                        presenceFresh,
                        displayedIsWallClimb,
                        commitButton,
                        displayedIsOwnCurrent,
                        pending,
                        offWall,
                        pressAction,
                        displayedLit: true,
                      });
                      const unlinked = !localConnected && !holderIsAuthoritative;
                      const ledless = pressAction === 'takeWall' || pressAction === 'releaseWall';
                      if (unlinked) {
                        expect(model.state).not.toBe('lit');
                        expect(model.selected).toBe(false);
                      }
                      // Where this phone can connect. With no Bluetooth to connect
                      // (`noop`) a preview's Set active is the only way to commit it.
                      const canConnect = pressAction === 'connect' || pending;
                      if (unlinked && displayedIsWallClimb && !offWall && !ledless && (canConnect || presenceFresh)) {
                        expect(model.state).not.toBe('put_on_wall');
                        if (presenceFresh) expect(model.state).toBe('on_wall_unlinked');
                      }
                      if (model.state === 'on_wall_unlinked') {
                        expect(model.holderFace).toBeNull();
                        expect(model.look).toBe('ready');
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(combinations).toBe(2304);
  });
});

// #7017, Marco: "The special coloured state for the button should only be
// shown when the current user is driving the board, meaning that a swipe from
// what they are currently seeing will change what's on the board."
describe('resolveWallControl: driving the board', () => {
  const LIT = { displayedLit: true };
  // In a crew swipes open previews (#4281): nothing this climber swipes moves the wall.
  const CREW = { navigationCommits: false };
  it.each([
    ['solo, lit on your link: the frost', { ...MINE, ...LIT }, { state: 'lit', holder: 'self', driving: true }],
    [
      'a crew, lit on your link: Disconnect board, no frost',
      { ...MINE, ...LIT, ...CREW },
      { state: 'lit', holder: 'self', driving: false, labelKey: 'disconnectBoard', look: 'lit' },
    ],
    [
      'a crew member on the wall’s climb, Sam’s link: no frost',
      { ...SAMS, ...LIT, ...CREW },
      { state: 'crew', holder: 'crew', driving: false, labelKey: 'putOnBoard', look: 'ready' },
    ],
    [
      'a preview of another climb on your link: no frost',
      { ...MINE, commitButton: 'putOnWall' as const, otherClimbLit: true },
      { state: 'put_on_wall', driving: false },
    ],
    ['your link, the climb on screen dark', { ...MINE }, { state: 'dark', driving: false }],
    // Not driving: a swipe browses, so no frost (#7017 review).
    [
      'not driving, lit on your link: no frost',
      { ...MINE, ...LIT, navigationCommits: false },
      { state: 'lit', holder: 'self', driving: false, labelKey: 'disconnectBoard' },
    ],
    // A wall with no lights you hold: amber only while your swipe moves it.
    [
      'solo, holding a wall with no lights: amber',
      { pressAction: 'releaseWall' as const, wallHeldLocally: true, offWall: true },
      { state: 'release_wall', holder: 'self', driving: true },
    ],
    [
      'a crew, holding a wall with no lights: no amber',
      { pressAction: 'releaseWall' as const, wallHeldLocally: true, offWall: true, ...CREW },
      { state: 'release_wall', holder: 'self', driving: false, labelKey: 'releaseWall', look: 'lit' },
    ],
    ['no board', {}, { state: 'connect', driving: false }],
  ] as const)('%s', (_case, input, expected) => {
    expect(resolveWallControl({ ...FREE, ...input })).toMatchObject(expected);
  });

  // The same account holds the board through another device: never "On Marco's
  // board" with this climber's own name and face.
  it('says On your other phone when this account holds the board on another device', () => {
    const model = resolveWallControl({
      ...FREE,
      ...LIT,
      ...CREW,
      holderIsAuthoritative: true,
      holderIsSelfAccount: true,
      pressAction: 'relay',
      crewFace: ME,
    });
    expect(model).toMatchObject({
      state: 'crew',
      holder: null,
      holderName: null,
      holderFace: null,
      driving: false,
      labelKey: 'putOnBoard',
      a11yValueKey: 'onOtherPhone',
      a11yHintKey: 'relayHintOtherPhone',
      bulbValueKey: 'onOtherPhone',
    });
  });
});

// #7113: a swipe on the wall button drives the wall, and a press on the frosted
// button stops driving and keeps the link. The label says what a press does.
describe('resolveWallControl: driving the wall', () => {
  type DriveMode = 'off' | 'arming' | 'live';
  const STATES: readonly [string, Partial<WallControlInput>][] = [
    ['connect', {}],
    ['put_on_wall', { commitButton: 'putOnWall' }],
    ["put_on_wall on Sam's board", { ...SAMS, commitButton: 'putOnWall' }],
    ['dark', MINE],
    ['on_wall_unlinked', { displayedIsWallClimb: true, presenceFresh: true }],
    ["crew (Sam's board)", { ...SAMS, displayedLit: true }],
  ];
  const cases: [string, Partial<WallControlInput>, boolean, boolean, DriveMode, boolean][] = [];
  for (const [name, input] of STATES) {
    for (const inCrew of [false, true]) {
      for (const swipesCommit of [true, false]) {
        for (const driveMode of ['off', 'arming', 'live'] as const) {
          for (const stopped of [false, true]) {
            cases.push([name, input, inCrew, swipesCommit, driveMode, stopped]);
          }
        }
      }
    }
  }

  it.each(cases)(
    '%s, crew %s, swipes commit %s, drive %s, stopped %s',
    (name, input, inCrew, swipesCommit, driveMode, stopped) => {
      const model = resolveWallControl({
        ...FREE,
        ...input,
        // Whatever the browse rule says (PlayCore feeds in a live drive).
        navigationCommits: swipesCommit && !inCrew,
        driveMode,
        drivingStopped: stopped,
      });
      expect(model.driving).toBe(false);
      if (name.startsWith('crew')) {
        // A relay to Sam's board: Put on board, never a swipe.
        expect(model).toMatchObject({ tapAction: 'relay', labelKey: 'putOnBoard', swipeAction: null });
        return;
      }
      if (name.includes("Sam's board")) {
        // A preview on Sam's board: Put on board, no swipe on a crewmate's board.
        expect(model).toMatchObject({ labelKey: 'putOnBoard', swipeAction: null });
        return;
      }
      expect(model.labelKey).toBe('putOnBoard');
      expect(model.swipeAction).toBe(driveMode === 'arming' ? null : 'drive');
    },
  );

  // Lit on this phone's link: whether it drives, row by row.
  // [crew, swipes commit, drive phase, stopped, driving]
  it.each<[boolean, boolean, DriveMode, boolean, boolean]>([
    [false, true, 'off', false, true],
    [false, true, 'off', true, false],
    [false, true, 'arming', false, true],
    [false, true, 'arming', true, false],
    [false, true, 'live', false, true],
    [false, true, 'live', true, false],
    [false, false, 'off', false, false],
    [false, false, 'off', true, false],
    [false, false, 'arming', false, false],
    [false, false, 'arming', true, false],
    [false, false, 'live', false, true],
    [false, false, 'live', true, false],
    [true, true, 'off', false, false],
    [true, true, 'off', true, false],
    [true, true, 'arming', false, false],
    [true, true, 'arming', true, false],
    [true, true, 'live', false, true],
    [true, true, 'live', true, false],
    [true, false, 'off', false, false],
    [true, false, 'off', true, false],
    [true, false, 'arming', false, false],
    [true, false, 'arming', true, false],
    [true, false, 'live', false, true],
    [true, false, 'live', true, false],
  ])(
    'lit on your link, crew %s, swipes commit %s, drive %s, stopped %s: driving %s',
    (inCrew, swipesCommit, driveMode, stopped, driving) => {
      const model = resolveWallControl({
        ...FREE,
        ...MINE,
        displayedLit: true,
        navigationCommits: swipesCommit && !inCrew,
        driveMode,
        drivingStopped: stopped,
      });
      expect(model).toMatchObject(
        driving
          ? {
              driving: true,
              tapAction: 'stop_driving',
              labelKey: 'youAreDriving',
              a11yValueKey: 'drivingEveryClimb',
              a11yHintKey: 'stopDrivingHint',
              swipeAction: null,
            }
          : {
              driving: false,
              tapAction: 'disconnect',
              labelKey: 'disconnectBoard',
              a11yValueKey: 'youHaveBoardLit',
              a11yHintKey: 'litHint',
              swipeAction: driveMode === 'arming' ? null : 'drive',
            },
      );
    },
  );

  // Sam holds the board and the climb on screen is theirs: nothing to relay, so
  // the label says whose board it is (one of the last status labels).
  it("says On Sam's board, with no tap and no swipe, when there is nothing to relay", () => {
    expect(resolveWallControl({ ...FREE, ...SAMS, pressAction: 'noop', displayedLit: true })).toMatchObject({
      state: 'crew',
      tapAction: 'noop',
      labelKey: 'onBoard',
      a11yValueKey: 'holderHasBoard',
      swipeAction: null,
      driving: false,
    });
  });

  it('covers every state, crew, setting, drive phase and stop', () => {
    expect(cases).toHaveLength(6 * 2 * 2 * 3 * 2);
  });

  it.each([
    ['the busy-wall question is up', { commitButton: 'putOnWall' as const, confirmArmed: true }],
    ['a connect is in flight', { pending: true, pressAction: 'noop' as const }],
    ['no wall is reachable (Set active)', { commitButton: 'putOnWall' as const, commitLabel: 'setActive' as const }],
    ['a wall with no lights, free', { pressAction: 'takeWall' as const, offWall: true }],
    ['a wall with no lights, yours', { pressAction: 'releaseWall' as const, wallHeldLocally: true, offWall: true }],
    [
      "a preview on the crew's gym board (a relay)",
      { commitButton: 'putOnWall' as const, offWall: true, gymBoardName: 'Kilter', crewGymBoard: true },
    ],
    ['Put on {board} at another gym board', { offWall: true, gymBoardName: 'Kilter' }],
    ['nothing to offer', { ...MINE, offWall: true }],
    [
      'a preview on a wall with no lights',
      { commitButton: 'putOnWall' as const, pressAction: 'releaseWall' as const, wallHeldLocally: true, offWall: true },
    ],
    ["a preview of another board's climb", { ...MINE, commitButton: 'putOnWall' as const, offWall: true }],
  ])('offers no swipe when %s', (_case, input) => {
    expect(resolveWallControl({ ...FREE, ...input }).swipeAction).toBeNull();
  });

  it('keeps Release the wall on a wall with no lights, even while its swipes move it', () => {
    expect(
      resolveWallControl({
        ...FREE,
        pressAction: 'releaseWall',
        wallHeldLocally: true,
        offWall: true,
        driveMode: 'live',
      }),
    ).toMatchObject({ driving: true, tapAction: 'release_wall', labelKey: 'releaseWall' });
  });

  it('waits on the busy-wall question while driving, still saying You are driving the wall', () => {
    expect(
      resolveWallControl({ ...FREE, ...MINE, displayedLit: true, confirmArmed: true, driveMode: 'live' }),
    ).toMatchObject({ driving: true, tapAction: 'noop', labelKey: 'youAreDriving', a11yHintKey: null });
  });

  it('never drives a climb lit on a crewmate’s link, whatever the drive phase', () => {
    expect(resolveWallControl({ ...FREE, ...SAMS, displayedLit: true, driveMode: 'live' }).driving).toBe(false);
  });

  // #7113 PR 2: the MiniPlayer's bulb reads this look, so a driver on the Climbs tab knows.
  it('gives the bulb the live fill only for a live drive, never for solo swipes that light', () => {
    expect(resolveWallControl({ ...FREE, ...MINE, displayedLit: true, driveMode: 'live' }).look).toBe('driving');
    expect(resolveWallControl({ ...FREE, ...MINE, displayedLit: true, navigationCommits: true }).look).toBe('lit');
    expect(resolveWallControl({ ...FREE, ...MINE, displayedLit: true, driveMode: 'arming' }).look).toBe('lit');
    expect(resolveWallControl({ ...FREE, ...SAMS, displayedLit: true, driveMode: 'live' }).look).not.toBe('driving');
  });

  it('says You are driving the wall, then that every climb picked lights up, and how to stop', () => {
    const t = ((key: string) => key) as unknown as TFunction;
    const text = wallControlText(
      resolveWallControl({ ...FREE, ...MINE, displayedLit: true, navigationCommits: false, driveMode: 'live' }),
      t,
      t,
    );
    expect(text).toMatchObject({
      label: 'playView.wallControl.youAreDriving',
      accessibilityLabel: 'playView.wallControl.youAreDriving, playView.wallControl.drivingEveryClimb',
      accessibilityHint: 'playView.wallControl.stopDrivingHint',
    });
  });
});

// Always drive the wall (2026-11): where it drives, a press that puts a climb up
// only drops a stop (`resume`); its open-ended drive lights the next ones once
// this phone's link holds the board. Stop driving after doesn't apply.
describe('resolveWallControl: a press resumes Always drive the wall', () => {
  const PUT_UP: readonly [string, Partial<WallControlInput>][] = [
    ['connect', {}],
    ['put_on_wall', { commitButton: 'putOnWall' }],
    ['put_on_wall, linked', { ...MINE, commitButton: 'putOnWall' }],
    ['dark', MINE],
    ['on_wall_unlinked', { displayedIsWallClimb: true, presenceFresh: true }],
  ];

  // [always drive, stopped, tapDrive]
  const RULES: [boolean, boolean, 'resume' | null][] = [
    [true, false, 'resume'],
    [true, true, 'resume'],
    [false, false, null],
    [false, true, null],
  ];
  const cases = PUT_UP.flatMap(([name, input]) => RULES.map((rule) => [name, input, ...rule] as const));

  it.each(cases)('%s, always drive %s, stopped %s: %s', (_name, input, alwaysDrive, stopped, tapDrive) => {
    const model = resolveWallControl({
      ...FREE,
      ...input,
      navigationCommits: false,
      drivingStopped: stopped,
      alwaysDrive,
    });
    expect(['connect', 'put_on_wall', 'relight']).toContain(model.tapAction);
    expect(model.tapDrive).toBe(tapDrive);
    // It never times a drive of its own.
    expect(model.tapKeepLighting).toBeNull();
  });

  it('never asks a press that puts nothing up to resume', () => {
    const always = { alwaysDrive: true };
    // Disconnect board, and You are driving the wall.
    expect(resolveWallControl({ ...FREE, ...MINE, ...always, displayedLit: true }).tapDrive).toBeNull();
    expect(
      resolveWallControl({ ...FREE, ...MINE, ...always, displayedLit: true, driveMode: 'live' }).tapDrive,
    ).toBeNull();
    // Set active: no wall in reach, so the press only makes the climb current.
    expect(
      resolveWallControl({ ...FREE, ...always, commitButton: 'putOnWall', commitLabel: 'setActive' }),
    ).toMatchObject({ tapAction: 'put_on_wall', labelKey: 'setActive', tapDrive: null });
  });

  // What the climber sees after the press: the model once the handler ran and
  // the watcher brought the drive back (`resume` drops the stop).
  it.each<[string, boolean, boolean]>([
    ['Always drive the wall on', true, true],
    ['Always drive the wall off', false, false],
  ])('%s: a press after a stop ends driving %s', (_name, alwaysDrive, drivingAfter) => {
    const before = resolveWallControl({
      ...FREE,
      ...MINE,
      commitButton: 'putOnWall',
      drivingStopped: true,
      alwaysDrive,
      navigationCommits: false,
    });
    expect(before.tapAction).toBe('put_on_wall');
    const resumed = before.tapDrive === 'resume';
    const after = resolveWallControl({
      ...FREE,
      ...MINE,
      displayedLit: true,
      drivingStopped: !resumed,
      driveMode: resumed ? 'live' : 'off',
      alwaysDrive,
      navigationCommits: resumed,
    });
    expect(after.driving).toBe(drivingAfter);
    expect(after.labelKey).toBe(drivingAfter ? 'youAreDriving' : 'disconnectBoard');
  });
});

// After Put on board, keep lighting (2.7): Stop driving after opens a window
// (or, for Until I stop, an open-ended drive) once the press's climb is up,
// wherever a swipe could start a drive. Never on a relay, Set active, a wall
// with no lights, or with the swipe's flag off. In a crew only with In a
// session too on. The model takes no board: every board, MoonBoards included,
// reads the same rule.
describe('resolveWallControl: Put on board keeps lighting', () => {
  const PUT_UP: readonly [string, Partial<WallControlInput>][] = [
    ['connect', {}],
    ['put_on_wall', { commitButton: 'putOnWall' }],
    ['put_on_wall, linked', { ...MINE, commitButton: 'putOnWall' }],
    ['dark', MINE],
    ['on_wall_unlinked', { displayedIsWallClimb: true, presenceFresh: true }],
  ];
  /** Solo, the flag on, Stop driving after at its default, Always drive the wall off. */
  const ON: Partial<WallControlInput> = {
    alwaysDrive: false,
    navigationCommits: false,
    swipeToDriveEnabled: true,
    keepLighting: '45',
    drivesInSession: true,
  };

  // [case, input, tapDrive, window ms, setting]
  const MATRIX: [
    string,
    Partial<WallControlInput>,
    'window' | 'drive' | 'resume' | null,
    number | null,
    string | null,
  ][] = [
    ['solo, 45 s', {}, 'window', 45_000, 'putOnBoardKeepsLighting'],
    ['solo, 30 s', { keepLighting: '30' }, 'window', 30_000, 'putOnBoardKeepsLighting'],
    ['solo, 1 minute', { keepLighting: '60' }, 'window', 60_000, 'putOnBoardKeepsLighting'],
    ['solo, 2 minutes', { keepLighting: '120' }, 'window', 120_000, 'putOnBoardKeepsLighting'],
    ['solo, 5 minutes', { keepLighting: '300' }, 'window', 300_000, 'putOnBoardKeepsLighting'],
    ['solo, Until I stop', { keepLighting: 'until_stopped' }, 'drive', null, 'putOnBoardKeepsLighting'],
    ['solo, Off', { keepLighting: 'off' }, null, null, null],
    ['a crew, In a session too on', { crewSession: true }, 'window', 45_000, 'putOnBoardKeepsLighting'],
    ['a crew, In a session too off', { crewSession: true, drivesInSession: false }, null, null, null],
    // The crew left seconds ago: the browse latch still holds, but the roster
    // (the watcher's read too) says solo, so In a session too has no say.
    [
      'the browse latch with no crew, In a session too off',
      { crewSession: false, drivesInSession: false },
      'window',
      45_000,
      'putOnBoardKeepsLighting',
    ],
    // Where Always drive the wall drives, its own drive lights the next climbs:
    // the timed choice doesn't apply.
    ['Always drive the wall on', { alwaysDrive: true }, 'resume', null, null],
    ['the swipe flag off', { swipeToDriveEnabled: false }, null, null, null],
  ];
  const cases = PUT_UP.flatMap(([name, state]) =>
    MATRIX.map(
      ([label, change, tapDrive, windowMs, setting]) =>
        [`${name}, ${label}`, state, change, tapDrive, windowMs, setting] as const,
    ),
  );

  it.each(cases)('%s', (_name, state, change, tapDrive, windowMs, setting) => {
    const model = resolveWallControl({ ...FREE, ...state, ...ON, ...change });
    expect(['connect', 'put_on_wall', 'relight']).toContain(model.tapAction);
    expect(model.tapDrive).toBe(tapDrive);
    if (tapDrive === 'window' || tapDrive === 'drive') {
      expect(model.tapKeepLighting).toEqual({ windowMs, setting });
    } else {
      expect(model.tapKeepLighting).toBeNull();
    }
  });

  it('never keeps lighting from a relay, Set active, a wall with no lights, or a press that puts nothing up', () => {
    // A crewmate's board: the press relays the climb to their phone.
    const relay = resolveWallControl({ ...FREE, ...SAMS, ...ON, commitButton: 'putOnWall' });
    expect(relay).toMatchObject({ holder: 'crew', tapDrive: null, tapKeepLighting: null });
    expect(relay.tapAction).not.toBe('connect');
    // Set active: no wall in reach.
    expect(resolveWallControl({ ...FREE, ...ON, commitButton: 'putOnWall', commitLabel: 'setActive' })).toMatchObject({
      labelKey: 'setActive',
      tapDrive: null,
      tapKeepLighting: null,
    });
    // A wall with no lights: Take the wall.
    expect(resolveWallControl({ ...FREE, ...ON, pressAction: 'takeWall' })).toMatchObject({
      tapAction: 'take_wall',
      tapDrive: null,
    });
    // A preview on a wall with no lights this phone holds (or one it doesn't
    // yet): Put on board makes the climb current, and nothing can light it, so
    // no window arms only to time out unlit.
    for (const ledless of [
      { pressAction: 'releaseWall' as const, wallHeldLocally: true },
      { pressAction: 'takeWall' as const },
    ]) {
      expect(
        resolveWallControl({
          ...FREE,
          ...ON,
          ...ledless,
          offWall: true,
          commitButton: 'putOnWall',
          commitLabel: 'putOnWall',
        }),
      ).toMatchObject({ state: 'put_on_wall', swipeAction: null, tapDrive: null, tapKeepLighting: null });
    }
    // Disconnect board puts nothing up.
    expect(resolveWallControl({ ...FREE, ...MINE, ...ON, displayedLit: true })).toMatchObject({
      tapAction: 'disconnect',
      tapDrive: null,
    });
  });

  it('never opens a second drive: arming, live, a connect in flight, or the busy-wall question', () => {
    expect(resolveWallControl({ ...FREE, ...MINE, ...ON, driveMode: 'arming' }).tapDrive).toBeNull();
    expect(resolveWallControl({ ...FREE, ...MINE, ...ON, driveMode: 'live' }).tapDrive).toBeNull();
    expect(resolveWallControl({ ...FREE, ...ON, pending: true }).tapDrive).toBeNull();
    expect(resolveWallControl({ ...FREE, ...MINE, ...ON, confirmArmed: true }).tapDrive).toBeNull();
  });

  it('opens a window after a stop on this link: the press starts a fresh one', () => {
    const model = resolveWallControl({ ...FREE, ...MINE, ...ON, commitButton: 'putOnWall', drivingStopped: true });
    expect(model.tapDrive).toBe('window');
  });
});

// Put on board's timed drive on this phone's lit climb (2.7, Stop driving
// after): a drive like any other, the frost and You are driving the wall, its
// press stops it and keeps the link, and the swipe stays offered to make it
// open-ended.
describe('resolveWallControl: Put on board’s timed drive', () => {
  const WINDOW: Partial<WallControlInput> = {
    ...MINE,
    displayedLit: true,
    driveMode: 'live',
    lightWindow: true,
    // A live drive commits every change of climb, which the player reads as navigationCommits.
    navigationCommits: true,
  };

  it('says You are driving the wall, stops on a press, and keeps the swipe to drive open-ended', () => {
    const model = resolveWallControl({ ...FREE, ...WINDOW });
    expect(model).toMatchObject({
      state: 'lit',
      holder: 'self',
      lightWindow: true,
      driving: true,
      labelKey: 'youAreDriving',
      // Told apart from an open-ended drive's stop for Wall Control Tapped only.
      tapAction: 'stop_window',
      a11yHintKey: 'stopDrivingHint',
      // The time left is the value, said on its own 10 s step.
      a11yValueKey: null,
      swipeAction: 'drive',
      selected: true,
      look: 'driving',
    });
  });

  it('waits on the busy-wall question', () => {
    expect(resolveWallControl({ ...FREE, ...WINDOW, confirmArmed: true }).tapAction).toBe('noop');
  });

  // The drive itself drives: not only the player's read of it.
  it('drives on the live timed drive alone, whatever the player reads as committing', () => {
    expect(resolveWallControl({ ...FREE, ...WINDOW, navigationCommits: false })).toMatchObject({
      lightWindow: true,
      driving: true,
      labelKey: 'youAreDriving',
      tapAction: 'stop_window',
      look: 'driving',
    });
  });

  it('is a timed drive only on a lit climb this phone holds', () => {
    // The climb on screen went dark under the window: Put on board relights it.
    expect(resolveWallControl({ ...FREE, ...WINDOW, displayedLit: false })).toMatchObject({
      state: 'dark',
      lightWindow: false,
      labelKey: 'putOnBoard',
    });
    // No clock: an open-ended drive, which offers no swipe.
    expect(resolveWallControl({ ...FREE, ...WINDOW, lightWindow: false })).toMatchObject({
      lightWindow: false,
      driving: true,
      labelKey: 'youAreDriving',
      tapAction: 'stop_driving',
      look: 'driving',
      swipeAction: null,
    });
    // A stop on this link: Disconnect board.
    expect(resolveWallControl({ ...FREE, ...WINDOW, drivingStopped: true, navigationCommits: false })).toMatchObject({
      lightWindow: false,
      labelKey: 'disconnectBoard',
      tapAction: 'disconnect',
    });
  });
});

// "On your other phone" keys on presence's named holder and the signed-in id,
// never on whoever lit the climb, and never on a profile still loading (#7017 review).
describe('isHolderSelfAccount', () => {
  it.each([
    ['presence names this account as the holder', 'me', 'me', true],
    ['presence names a crewmate', 'liz', 'me', false],
    // Only the sender fallback named this account: this phone's own climb from
    // before a relaunch, with no holder. Not another phone.
    ['no named holder (the climb was lit by this account)', null, 'me', false],
    // The profile still loading and no stored id yet: never "somebody else's
    // board" with this climber's own name, and never a guess either.
    ['the signed-in id not known yet', 'me', null, false],
  ] as const)('%s', (_case, holderUserId, viewerUserId, expected) => {
    expect(isHolderSelfAccount(holderUserId, viewerUserId)).toBe(expected);
  });
});

// The board sheet's status line (spec B3): the button's words, uncapped.
describe('resolveBoardSheetStatus', () => {
  const model = (change: Partial<WallControlModel>): WallControlModel => ({ ...EMPTY_WALL_CONTROL, ...change });
  it.each<[string, Partial<WallControlModel>, ReturnType<typeof resolveBoardSheetStatus>]>([
    ['a preview on this phone’s board', { state: 'put_on_wall', holder: 'self' }, 'preview'],
    ['a preview with nobody holding the board', { state: 'put_on_wall', holder: null }, 'preview'],
    ['lit on this phone’s link', { state: 'lit', holder: 'self' }, 'on_wall'],
    ['Put on board’s timed drive', { state: 'lit', holder: 'self', lightWindow: true, driving: true }, 'window'],
    ['an open-ended drive', { state: 'lit', holder: 'self', driving: true }, 'driving'],
    ['a crewmate’s board', { state: 'put_on_wall', holder: 'crew' }, null],
    ['a crewmate’s lit climb', { state: 'lit', holder: 'crew' }, null],
    ['dark', { state: 'dark', holder: 'self' }, null],
    ['no link', { state: 'connect' }, null],
    ['nothing to offer', {}, null],
  ])('%s: %s', (_name, change, status) => {
    expect(resolveBoardSheetStatus(model(change))).toBe(status);
  });

  it('reads the timed drive off a real resolved model', () => {
    const windowed = resolveWallControl({
      ...FREE,
      ...MINE,
      displayedLit: true,
      driveMode: 'live',
      lightWindow: true,
    });
    expect(resolveBoardSheetStatus(windowed)).toBe('window');
  });
});
