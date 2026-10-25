import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const state = vi.hoisted(() => ({ planSettles: false }));

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/request-read-budget', () => ({ remainingReadBudgetMs: () => 20 }));
vi.mock('@boardsesh/db/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/db/queries')>()),
  withSerialPlan: () =>
    state.planSettles ? Promise.resolve([[{ boardType: 'kilter', climbCount: 1 }], []]) : new Promise(() => {}),
}));
// Neither read ever answers: a saturated pool.
vi.mock('@/app/lib/db/db', () => ({
  dbz: {},
  executeRows: () => new Promise(() => {}),
}));

const { getSetterPageData } = await import('../server-setter-data');

describe('the setter page bounds its Postgres reads', () => {
  beforeEach(() => {
    state.planSettles = false;
  });

  it('rejects with a read timeout, not null, when the climbs plan never answers', async () => {
    await expect(getSetterPageData('marco', 1)).rejects.toThrow(/"setter-climbs"/);
  });

  it('rejects with a read timeout when the identity read never answers', async () => {
    state.planSettles = true;
    await expect(getSetterPageData('marco', 1)).rejects.toThrow(/"setter-identity"/);
  });
});
