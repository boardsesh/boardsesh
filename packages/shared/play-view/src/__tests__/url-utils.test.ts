import { describe, it, expect } from 'vitest';
import { buildReadableClimbViewPath } from '../readable-url-utils';
import { buildClimbViewPath } from '../url-utils';

describe('buildClimbViewPath', () => {
  it('builds a correct climb view path', () => {
    expect(buildClimbViewPath('kilter', 1, 10, '12,34', 40, 'abc-123')).toBe('/kilter/1/10/12,34/40/view/abc-123');
  });

  it('handles different board names', () => {
    expect(buildClimbViewPath('tension', 2, 20, '56', 25, 'xyz-789')).toBe('/tension/2/20/56/25/view/xyz-789');
  });
});

describe('buildReadableClimbViewPath', () => {
  it('builds the same readable Kilter Homewall view path as the web app', () => {
    expect(
      buildReadableClimbViewPath({
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 25,
        setIds: '26,27,28,29',
        angle: 35,
        climbUuid: '2266B5B86CFF49489381FF21B4B4B60A',
        climbName: 'Moon Landing',
      }),
    ).toBe(
      '/kilter/homewall/10x12-full-ride/main-kicker_main_aux-kicker_aux/35/view/moon-landing-2266B5B86CFF49489381FF21B4B4B60A',
    );
  });

  it('builds a readable path without a climb name', () => {
    expect(
      buildReadableClimbViewPath({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 7,
        setIds: '1,20',
        angle: 40,
        climbUuid: 'abc123',
      }),
    ).toBe('/kilter/original/12x14-commerical/screw_bolt/40/view/abc123');
  });

  it('falls back to numeric path with a climb slug when static board data cannot resolve', () => {
    expect(
      buildReadableClimbViewPath({
        boardName: 'kilter',
        layoutId: 9999,
        sizeId: 9999,
        setIds: '9999',
        angle: 40,
        climbUuid: 'abc123',
        climbName: 'Test Climb',
      }),
    ).toBe('/kilter/9999/9999/9999/40/view/test-climb-abc123');
  });

  it('falls back to numeric path when only some requested set ids resolve', () => {
    expect(
      buildReadableClimbViewPath({
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 25,
        setIds: '26,9999',
        angle: 35,
        climbUuid: 'abc123',
        climbName: 'Test Climb',
      }),
    ).toBe('/kilter/8/25/26,9999/35/view/test-climb-abc123');
  });

  it('falls back to numeric path when set ids contain invalid text', () => {
    expect(
      buildReadableClimbViewPath({
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 25,
        setIds: '26,abc',
        angle: 35,
        climbUuid: 'abc123',
        climbName: 'Test Climb',
      }),
    ).toBe('/kilter/8/25/26,abc/35/view/test-climb-abc123');
  });

  it('builds readable MoonBoard paths', () => {
    expect(
      buildReadableClimbViewPath({
        boardName: 'moonboard',
        layoutId: 3,
        sizeId: 1,
        setIds: '5,6,7,8',
        angle: 40,
        climbUuid: 'moon123',
        climbName: 'Wood Test',
      }),
    ).toBe(
      '/moonboard/2024/standard-11x18-grid/wooden-holds_hold-set-f_hold-set-e_hold-set-d/40/view/wood-test-moon123',
    );
  });
});
