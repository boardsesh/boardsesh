import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { CncOrder } from '@boardsesh/db/schema';

// The resolvers under test never touch the database directly — they go through
// services/cnc/orders — so the client is stubbed out entirely rather than
// chain-mocked. Both exports are supplied: helpers.ts reads `dbRead` too.
vi.mock('../../../../db/client', () => ({ db: {}, dbRead: {} }));

// applyRateLimit would reach the in-process limiter and Redis. Neither is what
// these tests are about, and a shared tier-1 bucket does not reset between
// tests, so the real one would make ordering matter.
vi.mock('../../shared/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/helpers')>()),
  applyRateLimit: vi.fn(async () => {}),
}));

const { listOrdersForUserMock, getOrderByLicenceIdMock, listOrdersForAdminMock } = vi.hoisted(() => ({
  listOrdersForUserMock: vi.fn(),
  getOrderByLicenceIdMock: vi.fn(),
  listOrdersForAdminMock: vi.fn(),
}));

// `toPublicOrder` is kept real: it is the function that strips the fingerprint
// manifest and the claim token, and a stub of it would make the leak tests
// below prove nothing.
vi.mock('../../../../services/cnc/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/cnc/orders')>()),
  listOrdersForUser: listOrdersForUserMock,
  getOrderByLicenceId: getOrderByLicenceIdMock,
  listOrdersForAdmin: listOrdersForAdminMock,
}));

// The admin gate reads community_roles. Stubbed so these tests are about what
// the resolver does on either side of it, not about the role query — every
// admin test below sets the mock's verdict explicitly.
const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn(async () => {}) }));
vi.mock('../../social/roles', () => ({ requireAdmin: requireAdminMock }));

const { fetchLayoutMock } = vi.hoisted(() => ({ fetchLayoutMock: vi.fn() }));

vi.mock('../../../../services/cnc/worker-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/cnc/worker-client')>()),
  fetchLayout: fetchLayoutMock,
}));

import { cncPackQueries, toGraphQLWorkerError } from '../queries';
import { applyRateLimit } from '../../shared/helpers';
import { CNC_CATALOG_VERSION } from '../../../../services/cnc/catalog';
import { CncConfigMappingError } from '../../../../services/cnc/worker-client';
import { logger } from '../../../../utils/logger';

const applyRateLimitMock = vi.mocked(applyRateLimit);

const OWNER_ID = 'user-owner';
const OTHER_ID = 'user-other';

const authCtx = (userId: string): ConnectionContext => ({
  connectionId: `conn-${userId}`,
  transport: 'http',
  isAuthenticated: true,
  userId,
});

const anonCtx = (): ConnectionContext => ({
  connectionId: 'conn-anon',
  transport: 'http',
  isAuthenticated: false,
});

/** Defaults for every option the catalogue defines, so a config only differs where a test says so. */
const DEFAULT_OPTIONS = {
  sheetStock: '2440x1220',
  panelThicknessMm: 18,
  tnutHoleDiameterMm: 12.5,
  ledHoleDiameterMm: 12.5,
  kickerMatClearanceMm: 50,
  studClearanceOffsetMm: 60,
  gridPitchMm: 100,
  dxfFlavour: 'R12_circles',
  paper: 'A3',
  engraveHoldIds: false,
  engraveAngleTicks: false,
};

function config(overrides: Record<string, unknown> = {}) {
  return {
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: DEFAULT_OPTIONS,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<CncOrder> = {}): CncOrder {
  return {
    id: 1,
    licenceId: 'BS-CNC-ABC234',
    userId: OWNER_ID,
    tier: 'personal',
    status: 'ready',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: DEFAULT_OPTIONS,
    artwork: null,
    catalogVersion: CNC_CATALOG_VERSION,
    licenseeName: 'Marco',
    licenseeEmail: 'marco@example.com',
    customerSiteName: null,
    licenceAcceptedAt: new Date('2026-09-01T00:00:00.000Z'),
    currency: 'AUD',
    amountCents: 14900,
    stripeCheckoutSessionId: 'cs_test_1',
    stripePaymentIntentId: 'pi_test_1',
    paidAt: new Date('2026-09-01T00:01:00.000Z'),
    refundedAt: null,
    queuedAt: new Date('2026-09-01T00:01:00.000Z'),
    claimedAt: new Date('2026-09-01T00:02:00.000Z'),
    heartbeatAt: new Date('2026-09-01T00:03:00.000Z'),
    workerId: 'worker-7',
    claimToken: 'claim-token-secret',
    attempts: 1,
    lastError: null,
    generation: 1,
    generatedAt: new Date('2026-09-01T00:04:00.000Z'),
    zipKey: 'cnc-packs/user-owner/BS-CNC-ABC234.zip',
    zipSizeBytes: 4_500_000,
    zipSha256: 'deadbeef',
    fingerprintManifest: { seed: 'never-publish-me' },
    downloadCount: 2,
    lastDownloadedAt: new Date('2026-09-02T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  } as CncOrder;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Back to "allowed" for every test, so the one that makes it reject cannot
  // leak its verdict into whatever runs next.
  requireAdminMock.mockResolvedValue(undefined);
});

describe('cncCatalog', () => {
  it('publishes the four Kilter Homewall walls', async () => {
    const catalog = await cncPackQueries.cncCatalog(undefined, undefined, anonCtx());

    expect(catalog.version).toBe(CNC_CATALOG_VERSION);
    expect(catalog.entries).toHaveLength(4);
    expect(catalog.entries.map((entry) => entry.label)).toEqual(['7x10', '10x10', '8x12', '10x12']);
    expect(catalog.entries.map((entry) => entry.sizeId)).toEqual([17, 21, 23, 25]);
  });

  it('does not publish the LED-kit size aliases', async () => {
    const catalog = await cncPackQueries.cncCatalog(undefined, undefined, anonCtx());

    for (const entry of catalog.entries) {
      expect(entry).not.toHaveProperty('sizeAliases');
    }
    // And nothing else smuggles the alias numbers through in another shape.
    expect(JSON.stringify(catalog)).not.toContain('sizeAliases');
  });

  it('flattens mixed-type option values to strings with the type they read back as', async () => {
    const entry = (await cncPackQueries.cncCatalog(undefined, undefined, anonCtx())).entries[3];
    const byKey = new Map(entry.manufacturingOptions.map((option) => [option.key, option]));

    expect(byKey.get('sheetStock')).toEqual({
      key: 'sheetStock',
      values: ['2440x1220', '3600x1220'],
      defaultValue: '2440x1220',
      valueType: 'string',
      kickerOnly: false,
    });
    expect(byKey.get('tnutHoleDiameterMm')).toMatchObject({ defaultValue: '12.5', valueType: 'number' });
    expect(byKey.get('engraveHoldIds')).toMatchObject({ values: ['false', 'true'], valueType: 'boolean' });
  });

  it('flags kickerMatClearanceMm as the only kicker-only option', async () => {
    const entry = (await cncPackQueries.cncCatalog(undefined, undefined, anonCtx())).entries[3];
    const byKey = new Map(entry.manufacturingOptions.map((option) => [option.key, option]));

    expect(byKey.get('kickerMatClearanceMm')).toMatchObject({ kickerOnly: true });
    for (const [key, option] of byKey) {
      if (key === 'kickerMatClearanceMm') continue;
      expect(option.kickerOnly).toBe(false);
    }
  });

  it("reports prices as amountCents, not the service layer's priceCents", async () => {
    const entry = (await cncPackQueries.cncCatalog(undefined, undefined, anonCtx())).entries[0];
    expect(entry.tiers).toEqual([
      { tier: 'personal', amountCents: 14900, currency: 'AUD' },
      { tier: 'commercial_single', amountCents: 75000, currency: 'AUD' },
    ]);
  });

  it('never leaks the Stripe price env var names', async () => {
    expect(JSON.stringify(await cncPackQueries.cncCatalog(undefined, undefined, anonCtx()))).not.toContain(
      'STRIPE_PRICE',
    );
  });

  it('meters the public read at 60/min on its own bucket', async () => {
    await cncPackQueries.cncCatalog(undefined, undefined, anonCtx());

    expect(applyRateLimitMock).toHaveBeenCalledWith(anonCtx(), 60, 'cncCatalog');
  });
});

describe('cncLayout', () => {
  it('returns the generator response for a configuration on sale', async () => {
    fetchLayoutMock.mockResolvedValue({ panels: [] });

    await expect(cncPackQueries.cncLayout(undefined, { config: config() }, anonCtx())).resolves.toEqual({ panels: [] });
    expect(fetchLayoutMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a size that is not on sale before calling the generator', async () => {
    await expect(
      cncPackQueries.cncLayout(undefined, { config: config({ sizeId: 999 }) }, anonCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });

    expect(fetchLayoutMock).not.toHaveBeenCalled();
  });

  it('rejects an option value outside the catalogue before calling the generator', async () => {
    await expect(
      cncPackQueries.cncLayout(
        undefined,
        { config: config({ options: { ...DEFAULT_OPTIONS, tnutHoleDiameterMm: 99 } }) },
        anonCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });

    expect(fetchLayoutMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed set id segment before calling the generator', async () => {
    await expect(
      cncPackQueries.cncLayout(undefined, { config: config({ setIds: '26,,27' }) }, anonCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });

    expect(fetchLayoutMock).not.toHaveBeenCalled();
  });

  it('rejects a set id that belongs to another wall before calling the generator', async () => {
    await expect(
      cncPackQueries.cncLayout(undefined, { config: config({ sizeId: 17, setIds: '26,27,28' }) }, anonCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });

    expect(fetchLayoutMock).not.toHaveBeenCalled();
  });

  it('rejects dropping a mandatory set before calling the generator', async () => {
    await expect(
      cncPackQueries.cncLayout(undefined, { config: config({ setIds: '26' }) }, anonCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });

    expect(fetchLayoutMock).not.toHaveBeenCalled();
  });

  it('accepts a 12 ft wall configured without its kicker', async () => {
    fetchLayoutMock.mockResolvedValue({ panels: [] });

    await cncPackQueries.cncLayout(undefined, { config: config({ setIds: '26,27' }) }, anonCtx());

    expect(fetchLayoutMock).toHaveBeenCalledTimes(1);
  });

  it('passes includeHoles through to the generator for an authenticated caller', async () => {
    fetchLayoutMock.mockResolvedValue({ panels: [] });

    await cncPackQueries.cncLayout(undefined, { config: config(), includeHoles: true }, authCtx(OWNER_ID));

    expect(fetchLayoutMock).toHaveBeenCalledWith(expect.anything(), { includeHoles: true });
  });

  it('requires authentication when includeHoles is set', async () => {
    await expect(
      cncPackQueries.cncLayout(undefined, { config: config(), includeHoles: true }, anonCtx()),
    ).rejects.toThrow(/Authentication required/);

    expect(fetchLayoutMock).not.toHaveBeenCalled();
  });

  it('stays public without includeHoles', async () => {
    fetchLayoutMock.mockResolvedValue({ panels: [] });

    await expect(cncPackQueries.cncLayout(undefined, { config: config() }, anonCtx())).resolves.toEqual({
      panels: [],
    });
  });

  it('applies the public 30/min ceiling when includeHoles is left off', async () => {
    fetchLayoutMock.mockResolvedValue({ panels: [] });

    await cncPackQueries.cncLayout(undefined, { config: config() }, anonCtx());

    expect(applyRateLimitMock).toHaveBeenCalledWith(anonCtx(), 30, 'cncLayout');
  });

  it('applies the tighter 10/min ceiling when includeHoles is set', async () => {
    fetchLayoutMock.mockResolvedValue({ panels: [] });

    await cncPackQueries.cncLayout(undefined, { config: config(), includeHoles: true }, authCtx(OWNER_ID));

    expect(applyRateLimitMock).toHaveBeenCalledWith(authCtx(OWNER_ID), 10, 'cncLayoutHoles');
  });

  it('classifies a config-mapping error the same as a worker rejection: CNC_INVALID_CONFIG', () => {
    const error = toGraphQLWorkerError(
      new CncConfigMappingError('Manufacturing option "sheetStock" is not <length>x<width>: bogus'),
    );

    expect(error).toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });
  });

  it('logs a thrown non-Error before reporting it as an outage', () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    try {
      const error = toGraphQLWorkerError('the generator rejected with a bare string');

      expect(error).toMatchObject({ extensions: { code: 'CNC_WORKER_UNAVAILABLE' } });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('Non-Error'), {
        error: 'the generator rejected with a bare string',
      });
    } finally {
      logged.mockRestore();
    }
  });
});

describe('myCncOrders', () => {
  it("asks only for the caller's own orders", async () => {
    listOrdersForUserMock.mockResolvedValue([makeOrder(), makeOrder({ id: 2, licenceId: 'BS-CNC-XYZ789' })]);

    const orders = await cncPackQueries.myCncOrders(undefined, undefined, authCtx(OWNER_ID));

    expect(listOrdersForUserMock).toHaveBeenCalledWith(OWNER_ID);
    expect(orders.map((order) => order.licenceId)).toEqual(['BS-CNC-ABC234', 'BS-CNC-XYZ789']);
  });

  it('requires authentication', async () => {
    await expect(cncPackQueries.myCncOrders(undefined, undefined, anonCtx())).rejects.toThrow(
      /Authentication required/,
    );
    expect(listOrdersForUserMock).not.toHaveBeenCalled();
  });

  it('strips the fingerprint manifest, claim token, worker id and raw error', async () => {
    listOrdersForUserMock.mockResolvedValue([makeOrder({ status: 'failed', lastError: 'ezdxf blew up in writer.py' })]);

    const [order] = await cncPackQueries.myCncOrders(undefined, undefined, authCtx(OWNER_ID));

    expect(order).not.toHaveProperty('fingerprintManifest');
    expect(order).not.toHaveProperty('claimToken');
    expect(order).not.toHaveProperty('workerId');
    const serialised = JSON.stringify(order);
    expect(serialised).not.toContain('never-publish-me');
    expect(serialised).not.toContain('claim-token-secret');
    expect(serialised).not.toContain('writer.py');
  });

  it('reports a fixed public message for a failed order and nothing for a healthy one', async () => {
    listOrdersForUserMock.mockResolvedValue([
      makeOrder({ status: 'failed', lastError: 'internal detail' }),
      makeOrder({ id: 2, licenceId: 'BS-CNC-XYZ789', status: 'ready' }),
    ]);

    const [failed, ready] = await cncPackQueries.myCncOrders(undefined, undefined, authCtx(OWNER_ID));

    expect(failed.errorMessage).toBe(
      'This pack could not be generated. Boardsesh has been notified and will be in touch by email.',
    );
    expect(ready.errorMessage).toBeNull();
  });

  it('serialises timestamps as ISO strings and the id as a string', async () => {
    listOrdersForUserMock.mockResolvedValue([makeOrder()]);

    const [order] = await cncPackQueries.myCncOrders(undefined, undefined, authCtx(OWNER_ID));

    expect(order.id).toBe('1');
    expect(order.createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(order.generatedAt).toBe('2026-09-01T00:04:00.000Z');
  });

  it('meters the read at 60/min on its own bucket', async () => {
    listOrdersForUserMock.mockResolvedValue([]);

    await cncPackQueries.myCncOrders(undefined, undefined, authCtx(OWNER_ID));

    expect(applyRateLimitMock).toHaveBeenCalledWith(authCtx(OWNER_ID), 60, 'myCncOrders');
  });

  it('rate-limits only after authentication, so an anonymous caller cannot drain the bucket', async () => {
    await expect(cncPackQueries.myCncOrders(undefined, undefined, anonCtx())).rejects.toThrow(
      /Authentication required/,
    );

    expect(applyRateLimitMock).not.toHaveBeenCalled();
  });
});

describe('cncOrder', () => {
  it("returns the caller's own order", async () => {
    getOrderByLicenceIdMock.mockResolvedValue(makeOrder());

    const order = await cncPackQueries.cncOrder(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx(OWNER_ID));

    expect(order?.licenceId).toBe('BS-CNC-ABC234');
  });

  it('returns null for a licence belonging to someone else', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(makeOrder());

    const order = await cncPackQueries.cncOrder(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx(OTHER_ID));

    expect(order).toBeNull();
  });

  it('returns null for a licence that does not exist, the same as for one it cannot see', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(null);

    await expect(
      cncPackQueries.cncOrder(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx(OWNER_ID)),
    ).resolves.toBeNull();
  });

  it('rejects a malformed licence id without looking it up', async () => {
    await expect(cncPackQueries.cncOrder(undefined, { licenceId: 'BS-CNC-abc234' }, authCtx(OWNER_ID))).rejects.toThrow(
      /licenceId/,
    );
    expect(getOrderByLicenceIdMock).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    await expect(cncPackQueries.cncOrder(undefined, { licenceId: 'BS-CNC-ABC234' }, anonCtx())).rejects.toThrow(
      /Authentication required/,
    );
    expect(getOrderByLicenceIdMock).not.toHaveBeenCalled();
    // Anonymous callers must not be able to spend an authenticated bucket.
    expect(applyRateLimitMock).not.toHaveBeenCalled();
  });

  it('meters the lookup at 60/min on a bucket of its own, separate from the orders list', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(makeOrder());

    await cncPackQueries.cncOrder(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx(OWNER_ID));

    expect(applyRateLimitMock).toHaveBeenCalledWith(authCtx(OWNER_ID), 60, 'cncOrder');
  });
});

describe('adminCncOrders', () => {
  const adminCtx = () => authCtx('user-admin');

  function page(orders: CncOrder[], hasMore = false) {
    return { orders, hasMore };
  }

  it('refuses a caller who is not an admin, before reading any order', async () => {
    requireAdminMock.mockRejectedValue(new Error('Admin role required for this operation'));

    await expect(cncPackQueries.adminCncOrders(undefined, {}, authCtx(OTHER_ID))).rejects.toThrow(/Admin role/);

    // The gate runs first: a refused caller costs neither a query nor a slot in
    // the rate-limit bucket.
    expect(listOrdersForAdminMock).not.toHaveBeenCalled();
    expect(applyRateLimitMock).not.toHaveBeenCalled();
  });

  it('publishes the three fields the buyer never sees', async () => {
    listOrdersForAdminMock.mockResolvedValue(
      page([makeOrder({ status: 'failed', attempts: 3, lastError: 'ezdxf: SEAM_TOO_CLOSE_TO_HOLE at panel 2' })]),
    );

    const result = await cncPackQueries.adminCncOrders(undefined, {}, adminCtx());
    const [entry] = result.orders;

    expect(entry.licenseeEmail).toBe('marco@example.com');
    expect(entry.attempts).toBe(3);
    expect(entry.lastError).toBe('ezdxf: SEAM_TOO_CLOSE_TO_HOLE at panel 2');
  });

  it('still redacts everything the buyer-facing shape redacts', async () => {
    listOrdersForAdminMock.mockResolvedValue(page([makeOrder({ status: 'failed', lastError: 'internal detail' })]));

    const result = await cncPackQueries.adminCncOrders(undefined, {}, adminCtx());
    const [entry] = result.orders;

    // The nested order is the buyer's own view, unchanged — the fingerprint
    // manifest and the claim token stay gone, and the buyer's `errorMessage` is
    // still the fixed public string rather than `lastError`.
    expect(JSON.stringify(entry.order)).not.toContain('never-publish-me');
    expect(JSON.stringify(entry.order)).not.toContain('claim-token-secret');
    expect(entry.order.errorMessage).not.toContain('internal detail');
  });

  it('passes the status filter through and defaults to 25 rows', async () => {
    listOrdersForAdminMock.mockResolvedValue(page([]));

    await cncPackQueries.adminCncOrders(undefined, { status: 'failed' }, adminCtx());

    expect(listOrdersForAdminMock).toHaveBeenCalledWith({ status: 'failed', limit: 25, after: null });
  });

  it('clamps an oversized limit instead of rejecting it', async () => {
    listOrdersForAdminMock.mockResolvedValue(page([]));

    await cncPackQueries.adminCncOrders(undefined, { limit: 5000 }, adminCtx());

    expect(listOrdersForAdminMock).toHaveBeenCalledWith({ status: null, limit: 100, after: null });
  });

  it('clamps a zero or negative limit up to one row', async () => {
    listOrdersForAdminMock.mockResolvedValue(page([]));

    await cncPackQueries.adminCncOrders(undefined, { limit: 0 }, adminCtx());

    expect(listOrdersForAdminMock).toHaveBeenCalledWith({ status: null, limit: 1, after: null });
  });

  it('hands back a cursor only when there is another page', async () => {
    listOrdersForAdminMock.mockResolvedValue(page([makeOrder()], false));

    const lastPage = await cncPackQueries.adminCncOrders(undefined, {}, adminCtx());

    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.cursor).toBeNull();
  });

  it('pages forward from the last row of the previous page', async () => {
    const older = makeOrder({ id: 7, createdAt: new Date('2026-08-30T00:00:00.000Z') });
    listOrdersForAdminMock.mockResolvedValue(page([makeOrder(), older], true));

    const first = await cncPackQueries.adminCncOrders(undefined, { limit: 2 }, adminCtx());
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBeTruthy();

    listOrdersForAdminMock.mockResolvedValue(page([]));
    await cncPackQueries.adminCncOrders(undefined, { limit: 2, cursor: first.cursor }, adminCtx());

    // The cursor names the LAST row of the page just served, so the next page
    // starts strictly after it — an offset would have skipped or repeated rows
    // as new orders landed at the front.
    expect(listOrdersForAdminMock).toHaveBeenLastCalledWith({
      status: null,
      limit: 2,
      after: { createdAt: older.createdAt, id: 7 },
    });
  });

  it('starts at the top for a cursor it cannot read, rather than serving an empty page', async () => {
    listOrdersForAdminMock.mockResolvedValue(page([]));

    await cncPackQueries.adminCncOrders(undefined, { cursor: 'not-a-cursor' }, adminCtx());

    expect(listOrdersForAdminMock).toHaveBeenCalledWith({ status: null, limit: 25, after: null });
  });

  it('meters the read at 60/min on a bucket of its own', async () => {
    listOrdersForAdminMock.mockResolvedValue(page([]));

    await cncPackQueries.adminCncOrders(undefined, {}, adminCtx());

    expect(applyRateLimitMock).toHaveBeenCalledWith(adminCtx(), 60, 'adminCncOrders');
  });
});
