import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import { costQueries } from '../queries';
import { costMutations } from '../mutations';

/**
 * Real-DB coverage for the cost-tracking resolvers: the admin gate on every
 * write + the admin list, the public runningCosts rollup (reachable
 * anonymously), and input validation. Seeds via the resolvers/raw SQL and calls
 * the resolvers directly against the per-worker test DB.
 */

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

const ADMIN = 'cost-admin';
const NON_ADMIN = 'cost-plain';

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertRole = (userId: string, role: string, boardType: string | null) =>
  db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES (${userId}, ${role}, ${boardType}, now())
  `);

const validRecurring = {
  kind: 'recurring',
  category: 'hosting',
  label: 'Vercel',
  amountCents: 2000,
  currency: 'USD',
  startMonth: '2020-01',
  endMonth: null,
  note: null,
};

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE "cost_entries", "community_roles", "users" RESTART IDENTITY CASCADE`);
  await Promise.all([insertUser(ADMIN), insertUser(NON_ADMIN)]);
  await insertRole(ADMIN, 'admin', null);
});

describe('cost mutations admin gate', () => {
  it('rejects an unauthenticated create', async () => {
    await expect(costMutations.createCostEntry(null, { input: validRecurring }, anonCtx())).rejects.toThrow(
      /Authentication required/i,
    );
  });

  it('rejects a non-admin create/update/delete', async () => {
    await expect(costMutations.createCostEntry(null, { input: validRecurring }, authCtx(NON_ADMIN))).rejects.toThrow(
      /Admin role required/i,
    );
    await expect(
      costMutations.updateCostEntry(null, { input: { id: '1', ...validRecurring } }, authCtx(NON_ADMIN)),
    ).rejects.toThrow(/Admin role required/i);
    await expect(costMutations.deleteCostEntry(null, { input: { id: '1' } }, authCtx(NON_ADMIN))).rejects.toThrow(
      /Admin role required/i,
    );
  });
});

describe('costEntries admin query', () => {
  it('rejects a non-admin caller', async () => {
    await expect(costQueries.costEntries(null, {}, authCtx(NON_ADMIN))).rejects.toThrow(/Admin role required/i);
  });

  it('lists what admins create', async () => {
    await costMutations.createCostEntry(null, { input: validRecurring }, authCtx(ADMIN));
    await costMutations.createCostEntry(
      null,
      { input: { ...validRecurring, label: 'Domain', category: 'domain', kind: 'incidental', startMonth: '2026-02' } },
      authCtx(ADMIN),
    );

    const rows = await costQueries.costEntries(null, {}, authCtx(ADMIN));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label).sort()).toEqual(['Domain', 'Vercel']);
    // id is serialized as a string for the GraphQL ID type.
    expect(typeof rows[0].id).toBe('string');
  });
});

describe('cost input validation', () => {
  it('rejects an incidental entry that carries an endMonth', async () => {
    await expect(
      costMutations.createCostEntry(
        null,
        { input: { ...validRecurring, kind: 'incidental', startMonth: '2026-01', endMonth: '2026-03' } },
        authCtx(ADMIN),
      ),
    ).rejects.toThrow();
  });

  it('rejects a malformed month key', async () => {
    await expect(
      costMutations.createCostEntry(null, { input: { ...validRecurring, startMonth: '2026-13' } }, authCtx(ADMIN)),
    ).rejects.toThrow();
  });

  it('rejects a recurring entry whose endMonth precedes startMonth', async () => {
    await expect(
      costMutations.createCostEntry(
        null,
        { input: { ...validRecurring, kind: 'recurring', startMonth: '2026-05', endMonth: '2026-01' } },
        authCtx(ADMIN),
      ),
    ).rejects.toThrow();
  });

  it('rejects an amount over the cap', async () => {
    await expect(
      costMutations.createCostEntry(null, { input: { ...validRecurring, amountCents: 100_000_001 } }, authCtx(ADMIN)),
    ).rejects.toThrow();
  });
});

describe('runningCosts public rollup', () => {
  it('is reachable anonymously and reflects an ongoing recurring bill', async () => {
    await costMutations.createCostEntry(null, { input: validRecurring }, authCtx(ADMIN));

    // No token — public query must not throw.
    const report = await costQueries.runningCosts(null, { months: 3 }, anonCtx());

    expect(report.currency).toBe('USD');
    expect(report.months).toHaveLength(3);
    // The recurring bill started in 2020 with no end, so it is active every month.
    expect(report.months.every((m) => m.recurringCents === 2000)).toBe(true);
    expect(report.latestMonthlyTotalCents).toBe(2000);
  });
});

describe('updateCostEntry / deleteCostEntry', () => {
  it('updates an entry and removes it', async () => {
    const created = await costMutations.createCostEntry(null, { input: validRecurring }, authCtx(ADMIN));

    const updated = await costMutations.updateCostEntry(
      null,
      { input: { id: created.id, ...validRecurring, amountCents: 3500 } },
      authCtx(ADMIN),
    );
    expect(updated.amountCents).toBe(3500);

    const removed = await costMutations.deleteCostEntry(null, { input: { id: created.id } }, authCtx(ADMIN));
    expect(removed).toBe(true);

    const rows = await costQueries.costEntries(null, {}, authCtx(ADMIN));
    expect(rows).toHaveLength(0);
  });

  it('throws when updating a missing entry', async () => {
    await expect(
      costMutations.updateCostEntry(null, { input: { id: '999999', ...validRecurring } }, authCtx(ADMIN)),
    ).rejects.toThrow(/not found/i);
  });
});
