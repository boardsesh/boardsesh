import { describe, it, expect } from 'vitest';
import { FavoriteToggleOrder } from '../favorite-toggle-order';

describe('FavoriteToggleOrder', () => {
  it('treats the newest toggle for a climb as the owner', () => {
    const order = new FavoriteToggleOrder();
    const first = order.begin('climb-1');
    const second = order.begin('climb-1');

    expect(order.isLatest('climb-1', first)).toBe(false);
    expect(order.isLatest('climb-1', second)).toBe(true);
  });

  it('tracks climbs independently', () => {
    const order = new FavoriteToggleOrder();
    const one = order.begin('climb-1');
    order.begin('climb-2');

    expect(order.isLatest('climb-1', one)).toBe(true);
  });

  it('releases the climb when its newest toggle settles', () => {
    const order = new FavoriteToggleOrder();
    const token = order.begin('climb-1');
    order.settle('climb-1', token);

    expect(order.isLatest('climb-1', token)).toBe(false);
  });

  it('a superseded toggle settling leaves the newer one owning the climb', () => {
    const order = new FavoriteToggleOrder();
    const first = order.begin('climb-1');
    const second = order.begin('climb-1');

    order.settle('climb-1', first);

    expect(order.isLatest('climb-1', second)).toBe(true);
  });
});
