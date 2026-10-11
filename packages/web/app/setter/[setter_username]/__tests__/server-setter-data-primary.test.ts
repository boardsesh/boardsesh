import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// A replica that is behind the primary. On the primary the setter's only climb
// sits on a spray wall that has just gone private (or been hidden by an admin),
// so the setter page's own predicate returns nothing. The replica has not
// replayed that change yet and still counts the climb.
const state = vi.hoisted(() => ({
  reads: [] as Array<'primary' | 'replica'>,
  identityReads: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/server-popular-configs', () => ({ getAllBoardConfigsOrThrow: async () => [] }));
vi.mock('@boardsesh/db/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/db/queries')>()),
  // The proxy driver below has no transactions. The serial-plan guard is not
  // what this test is about; which connection the reads go to is.
  withSerialPlan: async <T>(database: unknown, run: (tx: unknown) => Promise<T>) => run(database),
}));
vi.mock('@/app/lib/db/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy');
  const connection = (label: 'primary' | 'replica') =>
    drizzle(async (query) => {
      state.reads.push(label);
      // The board-type count is the GROUP BY query, in array mode: one spray
      // wall with one climb on the stale replica, nothing on the primary.
      const isCount = query.toLowerCase().includes('group by');
      return { rows: label === 'replica' && isCount ? [['spray', 1]] : [] };
    });
  return {
    dbz: connection('primary'),
    dbzRead: connection('replica'),
    executeRows: async () => {
      state.identityReads += 1;
      return [];
    },
  };
});

const { getSetterPageData } = await import('../server-setter-data');

describe('the setter page reads its climbs on the primary', () => {
  beforeEach(() => {
    state.reads.length = 0;
    state.identityReads = 0;
  });

  it('serves no page for a setter whose only climb is on a spray wall that just went private', async () => {
    expect(await getSetterPageData('spray-setter', 1)).toBeNull();
    // Both page queries ran, and on the primary: the replica, which still sees
    // the wall as public, was never asked.
    expect(state.reads).toEqual(['primary', 'primary']);
    expect(state.identityReads).toBe(0);
  });
});
