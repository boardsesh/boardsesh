import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { isHolderSelfAccount, resolveWallControl, type WallControlInput } from '../wall-control';
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
  autoDisconnectWarning: false,
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
      // The swipe takes Sam's board with a hand-off (#7113 PR 4).
      swipeAction: 'drive',
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
      // The swipe takes Sam's board with a hand-off (#7113 PR 4).
      swipeAction: 'drive',
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
      // The swipe asks Sam's phone to let go, then connects (#7113 PR 4).
      swipeAction: 'drive',
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

  it('carries the spinner, the write and the warning ring to every view', () => {
    expect(resolveWallControl({ ...FREE, ...MINE, writing: true, autoDisconnectWarning: true })).toMatchObject({
      writing: true,
      autoDisconnectWarning: true,
    });
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
    // Solo with Light the board as I swipe off: a swipe browses, so no frost (#7017 review).
    [
      'solo with lighting on swipes off, lit on your link: no frost',
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
      for (const lightOnSwipe of [true, false]) {
        for (const driveMode of ['off', 'arming', 'live'] as const) {
          for (const stopped of [false, true]) {
            cases.push([name, input, inCrew, lightOnSwipe, driveMode, stopped]);
          }
        }
      }
    }
  }

  it.each(cases)(
    '%s, crew %s, light on swipe %s, drive %s, stopped %s',
    (name, input, inCrew, lightOnSwipe, driveMode, stopped) => {
      const model = resolveWallControl({
        ...FREE,
        ...input,
        // The browse rule PlayCore feeds in: solo with lighting on swipes.
        navigationCommits: lightOnSwipe && !inCrew,
        driveMode,
        drivingStopped: stopped,
      });
      expect(model.driving).toBe(false);
      if (name.startsWith('crew')) {
        // A relay to Sam's board: Put on board, and the swipe takes it (#7113 PR 4).
        expect(model).toMatchObject({ tapAction: 'relay', labelKey: 'putOnBoard', holder: 'crew' });
      }
      expect(model.labelKey).toBe('putOnBoard');
      expect(model.swipeAction).toBe(driveMode === 'arming' ? null : 'drive');
    },
  );

  // Lit on this phone's link: whether it drives, row by row.
  // [crew, light on swipe, drive phase, stopped, driving]
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
    'lit on your link, crew %s, light on swipe %s, drive %s, stopped %s: driving %s',
    (inCrew, lightOnSwipe, driveMode, stopped, driving) => {
      const model = resolveWallControl({
        ...FREE,
        ...MINE,
        displayedLit: true,
        navigationCommits: lightOnSwipe && !inCrew,
        driveMode,
        drivingStopped: stopped,
      });
      expect(model).toMatchObject(
        driving
          ? {
              driving: true,
              tapAction: 'stop_driving',
              bulbTapAction: 'disconnect',
              labelKey: 'youAreDriving',
              a11yValueKey: 'drivingEveryClimb',
              a11yHintKey: 'stopDrivingHint',
              bulbA11yHintKey: 'litHint',
              swipeAction: null,
            }
          : {
              driving: false,
              tapAction: 'disconnect',
              bulbTapAction: 'disconnect',
              labelKey: 'disconnectBoard',
              a11yValueKey: 'youHaveBoardLit',
              a11yHintKey: 'litHint',
              bulbA11yHintKey: 'litHint',
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
      bulbTapAction: 'noop',
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
      // The hand-off is addressed by account: it can't tell this climber's two phones apart.
      "a relay to this climber's other phone",
      { holderIsAuthoritative: true, holderIsSelfAccount: true, pressAction: 'relay' as const },
    ],
    [
      "a preview relayed to the crew's gym board",
      {
        holderIsAuthoritative: true,
        pressAction: 'relay' as const,
        commitButton: 'putOnWall' as const,
        offWall: true,
        gymBoardName: 'Kilter',
        crewGymBoard: true,
      },
    ],
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
