import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { resolveWallControl, type WallControlInput } from '../wall-control';
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
    a11yLabelKey: string | null;
    a11yHintKey: string | null;
    look: string;
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
      labelKey: 'connect',
      a11yLabelKey: 'connect',
      a11yHintKey: 'connectHint',
      look: 'off',
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
      labelKey: 'putOnWall',
      a11yLabelKey: 'putOnWall',
      a11yHintKey: 'lightHint',
      look: 'off',
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
      a11yLabelKey: 'setActive',
      a11yHintKey: 'lightHint',
      look: 'off',
    },
  ],
  [
    'lit, this phone holds it',
    { ...MINE, displayedLit: true },
    {
      state: 'lit',
      holder: 'self',
      tapAction: 'disconnect',
      longPress: 'sheet',
      labelKey: 'youHaveBoard',
      a11yLabelKey: 'youHaveBoardLit',
      a11yHintKey: 'litHint',
      look: 'lit',
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
      labelKey: 'putOnWall',
      a11yLabelKey: 'putOnWall',
      a11yHintKey: 'lightHint',
      look: 'lit',
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
      labelKey: 'putOnWall',
      a11yLabelKey: 'putOnWall',
      a11yHintKey: 'lightHint',
      look: 'lit',
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
      labelKey: 'onBoard',
      a11yLabelKey: 'onBoard',
      a11yHintKey: 'relayHint',
      look: 'lit',
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
      labelKey: 'onBoard',
      a11yLabelKey: 'onBoard',
      a11yHintKey: 'relayHint',
      look: 'ready',
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
      a11yLabelKey: 'putOnBoard',
      a11yHintKey: 'lightHint',
      look: 'off',
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
      labelKey: 'youHaveBoard',
      a11yLabelKey: 'youHaveBoardLit',
      a11yHintKey: null,
      look: 'lit',
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
      labelKey: 'connect',
      a11yLabelKey: 'connect',
      a11yHintKey: null,
      look: 'off',
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
      a11yLabelKey: null,
      a11yHintKey: null,
      look: 'lit',
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
      a11yLabelKey: 'takeWall',
      a11yHintKey: null,
      look: 'off',
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
      a11yLabelKey: 'releaseWall',
      a11yHintKey: null,
      look: 'lit',
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
      labelKey: 'connect',
      a11yLabelKey: 'connect',
      a11yHintKey: 'connectHint',
      look: 'off',
    },
  ],
  [
    'presence names this climber, with no link',
    { holderIsAuthoritative: true, holderIsSelfAccount: true, crewFace: ME, pressAction: 'connect' },
    {
      state: 'crew',
      holder: null,
      tapAction: 'noop',
      longPress: null,
      labelKey: 'onCrewBoard',
      a11yLabelKey: 'onCrewBoard',
      a11yHintKey: null,
      look: 'ready',
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
      labelKey: 'onCrewBoard',
      a11yHolderKey: 'crewHasBoard',
      a11yHintKey: 'relayHintCrew',
    });
  });

  it("gives the bulb a value: You have the board, Sam's board, another climb up, or off", () => {
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

  it('says You have the board, and to a screen reader that the climb is lit, with the tap and the hold', () => {
    const text = wallControlText(resolveWallControl({ ...FREE, ...MINE, displayedLit: true }), t, t);
    expect(text).toMatchObject({
      label: 'playView.wallControl.youHaveBoard',
      accessibilityLabel: 'playView.wallControl.youHaveBoardLit',
      accessibilityHint: 'playView.wallControl.litHint',
      bulbAccessibilityLabel: 'playView.wallControl.bulbAria',
      bulbValue: 'playView.wallControl.youHaveBoardLit',
      longPressActionLabel: 'playView.wallControl.boardOptions',
    });
  });

  it('says the label, then who has the board', () => {
    const text = wallControlText(resolveWallControl({ ...FREE, ...SAMS }), t, t);
    expect(text.accessibilityLabel).toBe(
      'playView.wallControl.onBoard:{"name":"Sam"}, playView.wallControl.holderHasBoard:{"name":"Sam"}',
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
      'disconnect',
      'lit',
    ],
    ['stale, your link, lit', { ...WALL, ...MINE, displayedLit: true }, 'lit', 'disconnect', 'lit'],
    ["fresh, Sam's link", { ...WALL, ...SAMS, presenceFresh: true, displayedLit: true }, 'crew', 'relay', 'lit'],
    ["stale, Sam's link", { ...WALL, ...SAMS, displayedLit: true }, 'crew', 'relay', 'lit'],
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

  it('says On the wall, outlined, with no face, and says a tap lights it again', () => {
    const model = resolveWallControl({
      ...FREE,
      ...WALL,
      presenceFresh: true,
      displayedIsOwnCurrent: true,
      crewFace: SAM,
    });
    expect(model).toMatchObject({
      labelKey: 'onWall',
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
