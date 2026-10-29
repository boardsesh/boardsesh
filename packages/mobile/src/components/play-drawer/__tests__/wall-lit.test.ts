import { describe, expect, it } from 'vitest';
import { resolveWallLit, type WallLitInput, type WallLitState } from '../wall-lit';

const MY_CLIMB = 'my-climb';
const THEIR_CLIMB = 'their-climb';

const base: WallLitInput = {
  isAnonymous: false,
  boardHasLights: true,
  boardMismatch: false,
  otherBoard: false,
  displayedClimbUuid: MY_CLIMB,
  committedHeadUuid: MY_CLIMB,
  wallClimbUuid: null,
  isPreview: false,
  wallDriven: false,
  currentDark: false,
};

describe('resolveWallLit', () => {
  const cases: Array<[string, Partial<WallLitInput>, WallLitState | null]> = [
    ['first-timer: no board connected, nothing lit', {}, 'notLit'],
    ['the climb on screen is the lit one', { wallClimbUuid: MY_CLIMB, wallDriven: true }, 'lit'],
    // Presence can name a climb lit hours ago (#7000 QA): with no live link
    // nobody can see the LEDs, so the label never claims them.
    ['presence names it but no link drives the wall', { wallClimbUuid: MY_CLIMB }, 'notLit'],
    [
      "a crewmate's link drives the wall and lit this climb",
      { wallClimbUuid: MY_CLIMB, wallDriven: true, isPreview: true, committedHeadUuid: THEIR_CLIMB },
      'lit',
    ],
    [
      'solo preview while another climb is lit',
      { isPreview: true, displayedClimbUuid: THEIR_CLIMB, wallClimbUuid: MY_CLIMB, wallDriven: true },
      'notLit',
    ],
    ['solo preview with no board at all', { isPreview: true, displayedClimbUuid: THEIR_CLIMB }, 'notLit'],
    // QA #147: with no live link, presence is trusted for an hour.
    ['presence names it, lit under an hour ago, no link', { wallClimbUuid: MY_CLIMB, presenceFresh: true }, 'lit'],
    [
      'a preview of the wall’s climb, lit under an hour ago, no link',
      { isPreview: true, displayedClimbUuid: THEIR_CLIMB, wallClimbUuid: THEIR_CLIMB, presenceFresh: true },
      'lit',
    ],
    ['fresh presence names another climb, no link', { wallClimbUuid: THEIR_CLIMB, presenceFresh: true }, 'notLit'],
    [
      'fresh presence, but a crewmate turned the lights off',
      { wallClimbUuid: MY_CLIMB, presenceFresh: true, presenceClearedClimbUuid: MY_CLIMB },
      'notLit',
    ],
    // #7015 (ported from the deleted wall badge): a crewmate turned all the
    // lights off; this phone has no link and hears it through presence.
    [
      'crewmate turned the lights off on your current climb',
      { wallDriven: true, wallClimbUuid: MY_CLIMB, presenceClearedClimbUuid: MY_CLIMB },
      'notLit',
    ],
    [
      'your queue moved on before the presence echo: the new climb is not called dark',
      { wallDriven: true, presenceClearedClimbUuid: THEIR_CLIMB },
      'lit',
    ],
    [
      'a preview of the turned-off climb reads as a preview',
      { wallDriven: true, isPreview: true, displayedClimbUuid: THEIR_CLIMB, presenceClearedClimbUuid: THEIR_CLIMB },
      'notLit',
    ],
    ['a preview of your own current climb reads like the current climb', { isPreview: true }, 'notLit'],
    ['a preview of your own current climb on a driven wall', { isPreview: true, wallDriven: true }, 'lit'],
    // The link lights whatever is current; the server's echo can lag or never come offline.
    ['driven wall, echo not back yet', { wallDriven: true }, 'lit'],
    ['driven wall, but the 4 h hold keeps it dark', { wallDriven: true, currentDark: true }, 'notLit'],
    // Turn off all lights: the presence feed still names the climb.
    ['lights turned off on the lit climb', { wallDriven: true, wallClimbUuid: MY_CLIMB, currentDark: true }, 'notLit'],
    [
      'a dark current climb does not darken a preview of the lit one',
      {
        wallDriven: true,
        isPreview: true,
        displayedClimbUuid: THEIR_CLIMB,
        wallClimbUuid: THEIR_CLIMB,
        currentDark: true,
      },
      'lit',
    ],
    ['anonymous reader', { isAnonymous: true }, null],
    ['a wall with no lights', { boardHasLights: false }, null],
    ['the switch-board overlay covers the board', { boardMismatch: true }, null],
    // The wall refuses another board's holds, whatever presence or the link says.
    [
      'the current climb is for another board the climber can reach',
      { otherBoard: true, wallDriven: true, wallClimbUuid: MY_CLIMB },
      'notLit',
    ],
    ['no climb on screen', { displayedClimbUuid: null }, null],
  ];

  it.each(cases)('%s', (_scenario, overrides, expected) => {
    expect(resolveWallLit({ ...base, ...overrides })).toBe(expected);
  });
});
