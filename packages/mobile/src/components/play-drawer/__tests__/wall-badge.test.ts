import { describe, expect, it } from 'vitest';
import type { HoldPlacement } from '../../board-renderer/types';
import {
  resolveWallBadge,
  resolveWallBadgeSide,
  type WallBadgeInput,
  type WallBadgeResolution,
  type WallBadgeSideInput,
} from '../wall-badge';

const MY_CLIMB = 'my-climb';
const THEIR_CLIMB = 'their-climb';

const base: WallBadgeInput = {
  isAnonymous: false,
  boardHasLights: true,
  boardMismatch: false,
  displayedClimbUuid: MY_CLIMB,
  committedHeadUuid: MY_CLIMB,
  wallClimbUuid: null,
  isPreview: false,
  inCrew: false,
  wallDriven: false,
  heldDark: false,
};

describe('resolveWallBadge', () => {
  const cases: Array<[string, Partial<WallBadgeInput>, WallBadgeResolution]> = [
    ['first-timer: no board connected, nothing lit', {}, 'notOnWall'],
    ['the climb on screen is the lit one', { wallClimbUuid: MY_CLIMB, wallDriven: true }, 'onWall'],
    // The board keeps its last climb lit after the phone lets go.
    ['still lit after the phone disconnected', { wallClimbUuid: MY_CLIMB }, 'onWall'],
    [
      'solo preview while another climb is lit',
      { isPreview: true, displayedClimbUuid: THEIR_CLIMB, wallClimbUuid: MY_CLIMB, wallDriven: true },
      'previewNotLit',
    ],
    ['solo preview with no board at all', { isPreview: true, displayedClimbUuid: THEIR_CLIMB }, 'notOnWall'],
    [
      'crew preview: only you see it',
      { isPreview: true, inCrew: true, displayedClimbUuid: THEIR_CLIMB, wallClimbUuid: MY_CLIMB, wallDriven: true },
      'onlyYou',
    ],
    ['a preview of your own current climb reads like the current climb', { isPreview: true }, 'notOnWall'],
    // The link lights whatever is current; the server's echo can lag or never come offline.
    ['driven wall, echo not back yet', { wallDriven: true }, 'onWall'],
    ['driven wall, but the 4 h hold keeps it dark', { wallDriven: true, heldDark: true }, 'notOnWall'],
    ['anonymous reader', { isAnonymous: true }, null],
    ['a wall with no lights', { boardHasLights: false }, null],
    ['the switch-board overlay covers the board', { boardMismatch: true }, null],
    ['no climb on screen', { displayedClimbUuid: null }, null],
  ];

  it.each(cases)('%s', (_scenario, overrides, expected) => {
    expect(resolveWallBadge({ ...base, ...overrides })).toBe(expected);
  });
});

describe('resolveWallBadgeSide', () => {
  // A 1000 × 1000 board; the badge takes the top 10% and 30% of the width.
  const hold = (id: number, cx: number, cy: number, mirroredHoldId: number | null = null): HoldPlacement => ({
    id,
    mirroredHoldId,
    cx,
    cy,
    r: 20,
  });
  const TOP_LEFT = hold(1, 100, 40, 2);
  const TOP_RIGHT = hold(2, 900, 40, 1);
  const TOP_RIGHT_TOO = hold(3, 800, 60);
  const LOW = hold(4, 100, 600);
  const sideInput: WallBadgeSideInput = {
    litHoldIds: [],
    holds: [TOP_LEFT, TOP_RIGHT, TOP_RIGHT_TOO, LOW],
    mirrored: false,
    boardWidth: 1000,
    boardHeight: 1000,
    footprint: { width: 0.3, height: 0.1 },
  };

  it.each([
    ['both corners clear: left, where the eye starts', [LOW.id], 'left'],
    ['a hold in the top-left: right', [TOP_LEFT.id], 'right'],
    ['a hold in the top-right: left', [TOP_RIGHT.id], 'left'],
    ['holds in both: the corner with fewer', [TOP_LEFT.id, TOP_RIGHT.id, TOP_RIGHT_TOO.id], 'left'],
    ['one in each: a tie goes left', [TOP_LEFT.id, TOP_RIGHT.id], 'left'],
    ['an unknown hold id is ignored', [999], 'left'],
  ] as Array<[string, number[], 'left' | 'right']>)('%s', (_scenario, litHoldIds, expected) => {
    expect(resolveWallBadgeSide({ ...sideInput, litHoldIds })).toBe(expected);
  });

  it('a mirrored climb draws the hold at its mirror, so the badge flips', () => {
    expect(resolveWallBadgeSide({ ...sideInput, litHoldIds: [TOP_LEFT.id], mirrored: true })).toBe('left');
  });

  it('a hold whose circle only reaches into the band still counts', () => {
    const grazing = hold(5, 100, 115); // top edge at 95, inside the 100 band
    expect(resolveWallBadgeSide({ ...sideInput, holds: [grazing], litHoldIds: [grazing.id] })).toBe('right');
  });

  it('an unmeasured board falls back to left', () => {
    expect(resolveWallBadgeSide({ ...sideInput, boardWidth: 0, litHoldIds: [TOP_LEFT.id] })).toBe('left');
  });
});
