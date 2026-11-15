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

  it('tries every key of a flush that throws, reports the first failure, and does not replay it', () => {
    const invalidateQueries = vi.fn<QueryInvalidator['invalidateQueries']>((filters) => {
      if (filters.queryKey[0] === 'logbook') throw new Error('logbook reader is gone');
    });
    const batch = createInvalidationBatch({ invalidateQueries });

    batch.add([['logbook'], ['userTicks']]);
    expect(() => batch.flush()).toThrow('logbook reader is gone');
    expect(invalidateQueries.mock.calls).toEqual([[{ queryKey: ['logbook'] }], [{ queryKey: ['userTicks'] }]]);

    batch.flush();
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });
});

describe('independent original invalidation causes', () => {
  it('retains an independent live cause when an earlier cause expires', () => {
    const { client, invalidateQueries } = recordingClient();
    const batch = createInvalidationBatch(client);
    let oldLive = true;
    const old = () => {
      if (!oldLive) throw new Error('Expired original delivery');
    };
    batch.add([['favoriteStatus']], undefined, old);
    batch.add([['favoriteStatus']], undefined, () => {});
    oldLive = false;
    expect(old).toThrow();
    batch.flush();
    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ['favoriteStatus'] });
  });
  it('retains a still-valid older cause when the newer independent cause expires', () => {
    const { client, invalidateQueries } = recordingClient();
    const batch = createInvalidationBatch(client);
    batch.add([['favoriteStatus']], undefined, () => {});
    batch.add([['favoriteStatus']], undefined, () => {
      throw new Error('Newer response expired');
    });
    batch.flush();
    expect(invalidateQueries).toHaveBeenCalledOnce();
  });
  it('does not let a retired unscoped cause suppress a valid board-scoped cause', () => {
    const { client, filtersFor } = recordingClient();
    const batch = createInvalidationBatch(client);
    batch.add([['infiniteSearchClimbs']], undefined, () => {
      throw new Error('Old owner');
    });
    batch.add([['infiniteSearchClimbs']], KILTER_1, () => {});
    batch.flush();
    const filters = filtersFor('infiniteSearchClimbs');
    expect(filters).toHaveLength(1);
    expect(filters[0].predicate).toBeTypeOf('function');
  });
  it('rechecks each filter after an invalidator itself retires the view', () => {
    let live = true;
    const invalidateQueries = vi.fn(() => {
      live = false;
    });
    const batch = createInvalidationBatch({ invalidateQueries });
    batch.add([['favoriteStatus'], ['searchClimbs']], undefined, () => {
      if (!live) throw new Error('Retired');
    });
    batch.flush();
    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ['favoriteStatus'] });
  });
  it('refuses an eleventh retained mutation cause and drops all causes after flush', () => {
    const { client, invalidateQueries } = recordingClient();
    const batch = createInvalidationBatch(client);
    for (let index = 0; index < 10; index++) batch.add([['favoriteStatus']], undefined, () => {});
    expect(() => batch.add([['favoriteStatus']], undefined, () => {})).toThrow();
    batch.flush();
    batch.flush();
    expect(invalidateQueries).toHaveBeenCalledOnce();
    expect(() => batch.add([['favoriteStatus']], undefined, () => {})).not.toThrow();
  });
});
