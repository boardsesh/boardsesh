import { describe, expect, it } from 'vitest';
import { EMPTY_WALL_CONTROL } from '../wall-control';
import type { WallControlModel } from '../wall-control';
import { wallControlFrostHasLeds, wallControlUsesFrost } from '../wall-control-frost';

describe('wall control frost requires physical driving', () => {
  it.each(['connect', 'relight', 'put_on_wall', 'relay', 'move_to_board', 'disconnect', 'stop_driving'] as const)(
    'keeps the physical LED action %s plain without driving',
    (tapAction) => {
      const model = { ...EMPTY_WALL_CONTROL, state: 'lit' as const, tapAction };
      expect(wallControlUsesFrost(model)).toBe(false);
      expect(model.driving).toBe(false);
    },
  );
  it.each(['take_wall', 'release_wall', null] as const)('keeps %s unchanged even if driving', (state) => {
    expect(wallControlUsesFrost({ ...EMPTY_WALL_CONTROL, state, driving: true })).toBe(false);
  });
  it('keeps Set active and passive crew status plain, but preserves a confirmed drive', () => {
    const setActiveModel: WallControlModel = {
      ...EMPTY_WALL_CONTROL,
      state: 'put_on_wall',
      tapAction: 'put_on_wall',
      labelKey: 'setActive',
      driving: true,
    };
    expect(wallControlUsesFrost(setActiveModel)).toBe(false);
    expect(wallControlUsesFrost({ ...EMPTY_WALL_CONTROL, state: 'crew' })).toBe(false);
    expect(wallControlUsesFrost({ ...EMPTY_WALL_CONTROL, state: 'lit', driving: true })).toBe(true);
    const busyModels: [WallControlModel, boolean][] = [
      [{ ...EMPTY_WALL_CONTROL, state: 'crew', pending: true }, false],
      [{ ...EMPTY_WALL_CONTROL, state: 'connect', pending: true }, false],
      [{ ...EMPTY_WALL_CONTROL, state: 'lit', writing: true }, false],
      [{ ...EMPTY_WALL_CONTROL, state: 'lit', driving: true, pending: true, writing: true }, true],
    ];
    for (const [model, expected] of busyModels) expect(wallControlUsesFrost(model)).toBe(expected);
  });
  // 2.7: Put on board's timed drive is a drive like any other: the same frost,
  // which shrinks as its time runs out.
  it("frosts Put on board's timed drive as any drive", () => {
    const timed: WallControlModel = {
      ...EMPTY_WALL_CONTROL,
      state: 'lit',
      labelKey: 'youAreDriving',
      lightWindow: true,
      driving: true,
    };
    const openEnded: WallControlModel = { ...timed, lightWindow: false };
    expect(wallControlUsesFrost(timed)).toBe(true);
    expect(wallControlUsesFrost(openEnded)).toBe(true);
  });
  it('uses the actual target board LED contract, including moves from a ledless board', () => {
    expect(wallControlFrostHasLeds({ boardType: 'kilter' })).toBe(true);
    expect(wallControlFrostHasLeds({ boardType: 'kilter', hasLeds: false })).toBe(false);
    expect(wallControlFrostHasLeds({ boardType: 'spray' })).toBe(false);
    expect(wallControlFrostHasLeds({ boardType: 'spray' }, { boardType: 'tension' })).toBe(true);
    expect(wallControlFrostHasLeds({ boardType: 'kilter' }, { boardType: 'tension', hasLeds: false })).toBe(false);
    expect(wallControlFrostHasLeds({ boardType: 'kilter' }, { boardType: 'spray' })).toBe(false);
  });
});

describe('wallControlFrostHasLeds', () => {
  it('frosts a board with lights, and a wall a device lights', () => {
    expect(wallControlFrostHasLeds({ boardType: 'kilter' })).toBe(true);
    expect(wallControlFrostHasLeds({ boardType: 'kilter', hasLeds: true, litByWallDevice: true })).toBe(true);
    expect(wallControlFrostHasLeds({ boardType: 'spray', hasLeds: false, litByWallDevice: true })).toBe(true);
  });

  it('keeps a dark wall plain', () => {
    expect(wallControlFrostHasLeds({ boardType: 'kilter', hasLeds: false })).toBe(false);
    expect(wallControlFrostHasLeds({ boardType: 'spray', hasLeds: false })).toBe(false);
  });

  it('reads the target gym board over the active one', () => {
    expect(
      wallControlFrostHasLeds({ boardType: 'kilter' }, { boardType: 'tension', hasLeds: false, litByWallDevice: true }),
    ).toBe(true);
    expect(wallControlFrostHasLeds({ boardType: 'kilter' }, { boardType: 'tension', hasLeds: false })).toBe(false);
  });
});
