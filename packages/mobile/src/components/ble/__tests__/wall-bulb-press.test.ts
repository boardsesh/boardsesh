import { describe, expect, it } from 'vitest';
import type { PlayDrawerLightbulbPressAction } from '../../play-drawer/lightbulb-control';
import {
  resolveWallBulbLook,
  resolveWallControlAction,
  type WallControlAction,
  type WallControlState,
} from '../../play-drawer/wall-control';
import { getBleLightbulbVisualState } from '../ble-lightbulb-button-state';

// #7000: what a tap on the wall button (or the bulb back in the first row)
// does. It lights the climb or opens the board sheet, and never drops the link.
const pressActions: PlayDrawerLightbulbPressAction[] = [
  'connect',
  'disconnect',
  'relay',
  'takeWall',
  'releaseWall',
  'noop',
];
const states: WallControlState[] = ['connect', 'put_on_wall', 'lit', 'dark', 'crew', 'take_wall', 'release_wall', null];

describe('resolveWallControlAction', () => {
  it.each([
    ['lit', 'disconnect', 'disconnect'],
    ['dark', 'disconnect', 'relight'],
    ['put_on_wall', 'connect', 'put_on_wall'],
    ['put_on_wall', 'disconnect', 'put_on_wall'],
    ['put_on_wall', 'relay', 'put_on_wall'],
    ['connect', 'connect', 'connect'],
    ['connect', 'noop', 'noop'],
    ['crew', 'relay', 'relay'],
    ['crew', 'noop', 'noop'],
    ['take_wall', 'takeWall', 'take_wall'],
    ['release_wall', 'releaseWall', 'release_wall'],
    [null, 'noop', 'noop'],
  ] as Array<[WallControlState, PlayDrawerLightbulbPressAction, WallControlAction]>)(
    '%s (press action %s) → %s',
    (state, pressAction, expected) => {
      expect(resolveWallControlAction({ state, pressAction, confirmArmed: false })).toBe(expected);
    },
  );

  // Marco's phone test (#7000): only You have the board lets go on a tap.
  it('disconnects only from You have the board, whatever the press action', () => {
    for (const state of states) {
      for (const pressAction of pressActions) {
        const disconnects = resolveWallControlAction({ state, pressAction, confirmArmed: false }) === 'disconnect';
        expect(disconnects).toBe(state === 'lit');
      }
    }
  });

  // The busy-wall question's Put mine up is the one answer; a tap must not give it.
  it('does nothing while the busy-wall question is up, whatever it shows', () => {
    for (const state of states) {
      for (const pressAction of pressActions) {
        expect(resolveWallControlAction({ state, pressAction, confirmArmed: true })).toBe('noop');
      }
    }
  });
});

describe('the bulb’s look, back in the first row', () => {
  it.each([
    ['connect', false, 'off'],
    [null, false, 'off'],
    ['put_on_wall', false, 'off'],
    // Marco's QA: filled whenever this phone holds the board, a preview included.
    ['put_on_wall', true, 'lit'],
    ['dark', true, 'lit'],
    ['lit', true, 'lit'],
    ['crew', false, 'lit'],
    ['on_wall_unlinked', false, 'ready'],
    ['take_wall', false, 'off'],
    ['release_wall', false, 'lit'],
  ] as Array<[WallControlState, boolean, string]>)('%s, this phone holds %s → %s', (state, selfHolds, expected) => {
    expect(resolveWallBulbLook(state, selfHolds)).toBe(expected);
  });

  // #7015: a crewmate turned the lights off; presence says the climb is dark.
  it("reads a crewmate's board dark once they turned the lights off", () => {
    expect(resolveWallBulbLook('crew', false, false)).toBe('ready');
    expect(resolveWallBulbLook('crew', false, true)).toBe('lit');
  });

  it('draws ready as an amber outline and off as a grey one', () => {
    const colours = { connectedColor: 'amber', disconnectedColor: 'grey' };
    expect(getBleLightbulbVisualState({ isConnected: false, ready: true, ...colours })).toEqual({
      iconName: 'lightbulb',
      iconColor: 'amber',
    });
    expect(getBleLightbulbVisualState({ isConnected: false, ...colours })).toEqual({
      iconName: 'lightbulb',
      iconColor: 'grey',
    });
    expect(getBleLightbulbVisualState({ isConnected: true, ready: true, ...colours }).iconName).toBe('lightbulb.fill');
  });
});
