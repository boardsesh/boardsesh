import { describe, expect, it } from 'vitest';
import type { ActionBarLayout } from '../action-bar-layout';
import {
  isActionableWallControlState,
  isWallControlDrawn,
  resolveWallControlState,
  resolveWallHolder,
  type WallControlState,
  type WallControlStateInput,
} from '../wall-control';

/** No board linked, nothing in flight, nobody else holding it. */
const base: WallControlStateInput = {
  commitButton: null,
  pressAction: 'connect',
  holderIsAuthoritative: false,
  localConnected: false,
  pending: false,
  displayedLit: false,
  offWall: false,
};

describe('resolveWallControlState', () => {
  it.each([
    ['no board: connect', {}, 'connect'],
    ['a connect in flight keeps the connect state', { pressAction: 'noop', pending: true }, 'connect'],
    ['a preview with no board: Put on the wall (it connects after)', { commitButton: 'putOnWall' }, 'put_on_wall'],
    [
      'a preview on a linked board',
      { commitButton: 'putOnWall', pressAction: 'disconnect', localConnected: true },
      'put_on_wall',
    ],
    ['linked, this climb lit', { pressAction: 'disconnect', localConnected: true, displayedLit: true }, 'lit'],
    ['linked, this climb dark', { pressAction: 'disconnect', localConnected: true }, 'dark'],
    ['a crewmate holds the board, a preview relays', { pressAction: 'relay', holderIsAuthoritative: true }, 'crew'],
    ['a crewmate holds the board, nothing to relay', { pressAction: 'noop', holderIsAuthoritative: true }, 'crew'],
    [
      'crew browse: Put on the wall wins over the holder',
      { commitButton: 'putOnWall', pressAction: 'relay', holderIsAuthoritative: true },
      'put_on_wall',
    ],
    ['a wall with no lights, free', { pressAction: 'takeWall' }, 'take_wall'],
    ['a wall with no lights, held here', { pressAction: 'releaseWall' }, 'release_wall'],
    ['no board selected', { pressAction: 'noop' }, null],
    // The busy-wall question takes the row; the bulb still reads the link.
    [
      'the busy-wall question, linked',
      { commitButton: 'confirm', pressAction: 'disconnect', localConnected: true },
      'dark',
    ],
  ] as Array<[string, Partial<WallControlStateInput>, WallControlState]>)(
    '%s → %s',
    (_scenario, overrides, expected) => {
      expect(resolveWallControlState({ ...base, ...overrides })).toBe(expected);
    },
  );

  // The switch-board overlay, another board's climb, a board with no lights:
  // a tap could only re-send the head, so there is no control at all.
  it.each([
    ['linked, lit', { pressAction: 'disconnect', localConnected: true, displayedLit: true }],
    ['linked, dark', { pressAction: 'disconnect', localConnected: true }],
    ['no board linked', {}],
    ['a crewmate holds it', { pressAction: 'relay', holderIsAuthoritative: true }],
  ] as Array<[string, Partial<WallControlStateInput>]>)('offers nothing off the wall: %s', (_scenario, overrides) => {
    expect(resolveWallControlState({ ...base, ...overrides, offWall: true })).toBeNull();
  });

  it('keeps take and release on a wall with no lights, and a preview’s Put on the wall', () => {
    expect(resolveWallControlState({ ...base, pressAction: 'takeWall', offWall: true })).toBe('take_wall');
    expect(resolveWallControlState({ ...base, pressAction: 'releaseWall', offWall: true })).toBe('release_wall');
    expect(resolveWallControlState({ ...base, commitButton: 'putOnWall', offWall: true })).toBe('put_on_wall');
  });

  it('never says lit without this phone’s link: presence alone can name a climb lit hours ago', () => {
    expect(resolveWallControlState({ ...base, displayedLit: true })).toBe('connect');
    expect(
      resolveWallControlState({ ...base, pressAction: 'noop', holderIsAuthoritative: true, displayedLit: true }),
    ).toBe('crew');
  });
});

describe('isActionableWallControlState', () => {
  it('counts only the states that ask the climber to act', () => {
    const states: WallControlState[] = [
      'connect',
      'put_on_wall',
      'lit',
      'dark',
      'crew',
      'take_wall',
      'release_wall',
      null,
    ];
    expect(states.filter(isActionableWallControlState)).toEqual(['connect', 'put_on_wall']);
  });
});

describe('isWallControlDrawn', () => {
  const layout = (overrides: Partial<Pick<ActionBarLayout, 'secondaryRow' | 'trailingSlot' | 'primaryCenter'>>) => ({
    primaryCenter: 'tick' as ActionBarLayout['primaryCenter'],
    secondaryRow: ['wallControl'] as ActionBarLayout['secondaryRow'],
    trailingSlot: 'queue' as ActionBarLayout['trailingSlot'],
    ...overrides,
  });

  it('counts the wall button in every state it asks in', () => {
    expect(isWallControlDrawn(layout({}), 'connect')).toBe(true);
    expect(isWallControlDrawn(layout({}), 'put_on_wall')).toBe(true);
  });

  it('counts the bulb, back in the first row, for a connect while the second row is taken', () => {
    expect(isWallControlDrawn(layout({ secondaryRow: 'workoutOutcome', trailingSlot: 'lightbulb' }), 'connect')).toBe(
      true,
    );
    expect(isWallControlDrawn(layout({ secondaryRow: 'confirm', trailingSlot: 'lightbulb' }), 'connect')).toBe(true);
  });

  it("counts the workout's top-row wall button in every state it asks in", () => {
    const workoutRow = layout({ primaryCenter: 'wallControl', secondaryRow: 'workoutOutcome', trailingSlot: null });
    expect(isWallControlDrawn(workoutRow, 'connect')).toBe(true);
    expect(isWallControlDrawn(workoutRow, 'put_on_wall')).toBe(true);
  });

  it('counts nothing when neither is on screen', () => {
    expect(isWallControlDrawn(layout({ secondaryRow: 'workoutOutcome' }), 'connect')).toBe(false);
    expect(isWallControlDrawn(layout({ secondaryRow: 'confirm', trailingSlot: 'lightbulb' }), 'put_on_wall')).toBe(
      false,
    );
  });
});

describe('resolveWallHolder', () => {
  it.each([
    ['this phone holds the link', { localConnected: true }, 'self'],
    ['this phone holds a wall with no lights', { wallHeldLocally: true }, 'self'],
    ['a crewmate holds it', { holderIsAuthoritative: true }, 'crew'],
    ['this phone wins over a stale crew read', { localConnected: true, holderIsAuthoritative: true }, 'self'],
    ['nobody', {}, null],
  ] as const)('%s → %s', (_scenario, input, expected) => {
    expect(
      resolveWallHolder({ localConnected: false, wallHeldLocally: false, holderIsAuthoritative: false, ...input }),
    ).toBe(expected);
  });
});
