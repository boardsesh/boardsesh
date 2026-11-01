import { describe, expect, it } from 'vitest';
import { EMPTY_WALL_CONTROL } from '../wall-control';
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
    expect(
      wallControlUsesFrost({
        ...EMPTY_WALL_CONTROL,
        state: 'put_on_wall',
        tapAction: 'put_on_wall',
        labelKey: 'setActive',
        driving: true,
      }),
    ).toBe(false);
    expect(wallControlUsesFrost({ ...EMPTY_WALL_CONTROL, state: 'crew' })).toBe(false);
    expect(wallControlUsesFrost({ ...EMPTY_WALL_CONTROL, state: 'crew', pending: true })).toBe(false);
    expect(wallControlUsesFrost({ ...EMPTY_WALL_CONTROL, state: 'lit', driving: true })).toBe(true);
    expect(wallControlUsesFrost({ ...EMPTY_WALL_CONTROL, state: 'connect', pending: true })).toBe(false);
    expect(wallControlUsesFrost({ ...EMPTY_WALL_CONTROL, state: 'lit', writing: true })).toBe(false);
    expect(
      wallControlUsesFrost({ ...EMPTY_WALL_CONTROL, state: 'lit', driving: true, pending: true, writing: true }),
    ).toBe(true);
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
