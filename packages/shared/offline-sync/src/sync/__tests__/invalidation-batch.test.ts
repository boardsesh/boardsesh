import { describe, expect, it, vi } from 'vitest';
import type { QueryInvalidator } from '../../database';
import { createInvalidationBatch } from '../invalidation-batch';

type Filters = Parameters<QueryInvalidator['invalidateQueries']>[0];

const KILTER_1 = { boardType: 'kilter', layoutId: 1 };
const SPRAY_36 = { boardType: 'spray', layoutId: 36 };

function recordingClient() {
  const invalidateQueries = vi.fn<QueryInvalidator['invalidateQueries']>();
  const filtersFor = (head: string): Filters[] =>
    invalidateQueries.mock.calls.map(([filters]) => filters).filter((filters) => filters.queryKey[0] === head);
  return { client: { invalidateQueries }, invalidateQueries, filtersFor };
}

describe('createInvalidationBatch', () => {
  it('invalidates nothing until it is flushed', () => {
    const { client, invalidateQueries } = recordingClient();
    const batch = createInvalidationBatch(client);

    batch.add([['logbook'], ['userTicks']]);

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates a key several tables share once, in the order it was first queued', () => {
    const { client, invalidateQueries } = recordingClient();
    const batch = createInvalidationBatch(client);

    batch.add([['logbook'], ['searchClimbs']]);
    batch.add([['favoriteStatus'], ['searchClimbs']]);
    batch.add([['logbook']]);
    batch.flush();

    expect(invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ['logbook'] }],
      [{ queryKey: ['searchClimbs'] }],
      [{ queryKey: ['favoriteStatus'] }],
    ]);
  });

  it('keeps a board-scoped key apart per board, each reaching only its own queries', () => {
    const { client, filtersFor } = recordingClient();
    const batch = createInvalidationBatch(client);

    // Climbs then stats of the same wall, then another board.
    batch.add([['infiniteSearchClimbs']], SPRAY_36);
    batch.add([['infiniteSearchClimbs']], SPRAY_36);
    batch.add([['infiniteSearchClimbs']], KILTER_1);
    batch.flush();

    const [sprayFilters, kilterFilters] = filtersFor('infiniteSearchClimbs');
    expect(filtersFor('infiniteSearchClimbs')).toHaveLength(2);
    const kilterList = { queryKey: ['infiniteSearchClimbs', { boardName: 'kilter', layoutId: 1 }] };
    const sprayList = { queryKey: ['infiniteSearchClimbs', { boardName: 'spray', layoutId: 36 }] };
    expect(sprayFilters.predicate?.(sprayList)).toBe(true);
    expect(sprayFilters.predicate?.(kilterList)).toBe(false);
    expect(kilterFilters.predicate?.(kilterList)).toBe(true);
    expect(kilterFilters.predicate?.(sprayList)).toBe(false);
  });

  it.each([
    ['queued before', true],
    ['queued after', false],
  ])('lets the same key for every board absorb the one board, %s', (_label, unscopedFirst) => {
    const { client, filtersFor } = recordingClient();
    const batch = createInvalidationBatch(client);

    if (unscopedFirst) batch.add([['infiniteSearchClimbs']]);
    batch.add([['infiniteSearchClimbs']], SPRAY_36);
    if (!unscopedFirst) batch.add([['infiniteSearchClimbs']]);
    batch.flush();

    expect(filtersFor('infiniteSearchClimbs')).toEqual([{ queryKey: ['infiniteSearchClimbs'] }]);
  });

  it('ignores the board for a key that is not board-scoped', () => {
    const { client, invalidateQueries } = recordingClient();
    const batch = createInvalidationBatch(client);

    batch.add([['climb']], SPRAY_36);
    batch.add([['climb']], KILTER_1);
    batch.flush();

    expect(invalidateQueries.mock.calls).toEqual([[{ queryKey: ['climb'] }]]);
  });

  it('passes a direct filter through as given, and keeps exact apart from prefix', () => {
    const { client, invalidateQueries } = recordingClient();
    const batch = createInvalidationBatch(client);

    batch.addFilters({ queryKey: ['sprayWallByLayout', 4], exact: true });
    batch.addFilters({ queryKey: ['sprayWallByLayout', 4], exact: true });
    batch.addFilters({ queryKey: ['sprayWallByLayout', 4] });
    batch.addFilters({ queryKey: ['sprayWallRenderData', 'board-4'] });
    batch.flush();

    expect(invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ['sprayWallByLayout', 4], exact: true }],
      [{ queryKey: ['sprayWallByLayout', 4] }],
      [{ queryKey: ['sprayWallRenderData', 'board-4'] }],
    ]);
  });

  it('is empty after a flush', () => {
    const { client, invalidateQueries } = recordingClient();
    const batch = createInvalidationBatch(client);

    batch.add([['logbook']]);
    batch.flush();
    batch.flush();
    expect(invalidateQueries).toHaveBeenCalledTimes(1);

    batch.add([['logbook']]);
    batch.flush();
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('does not replay a flush that threw', () => {
    const invalidateQueries = vi.fn<QueryInvalidator['invalidateQueries']>(() => {
      throw new Error('query client is gone');
    });
    const batch = createInvalidationBatch({ invalidateQueries });

    batch.add([['logbook'], ['userTicks']]);
    expect(() => batch.flush()).toThrow('query client is gone');
    batch.flush();

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
  });
});
