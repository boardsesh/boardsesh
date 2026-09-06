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

const { listOrdersForUserMock, getOrderByLicenceIdMock } = vi.hoisted(() => ({
  listOrdersForUserMock: vi.fn(),
  getOrderByLicenceIdMock: vi.fn(),
}));

// `toPublicOrder` is kept real: it is the function that strips the fingerprint
// manifest and the claim token, and a stub of it would make the leak tests
// below prove nothing.
vi.mock('../../../../services/cnc/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/cnc/orders')>()),
  listOrdersForUser: listOrdersForUserMock,
  getOrderByLicenceId: getOrderByLicenceIdMock,
}));

const { fetchLayoutMock } = vi.hoisted(() => ({ fetchLayoutMock: vi.fn() }));

vi.mock('../../../../services/cnc/worker-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/cnc/worker-client')>()),
  fetchLayout: fetchLayoutMock,
}));

import { cncPackQueries } from '../queries';
import { CNC_CATALOG_VERSION } from '../../../../services/cnc/catalog';

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
});

describe('cncCatalog', () => {
  it('publishes the four Kilter Homewall walls', () => {
    const catalog = cncPackQueries.cncCatalog();

    expect(catalog.version).toBe(CNC_CATALOG_VERSION);
    expect(catalog.entries).toHaveLength(4);
    expect(catalog.entries.map((entry) => entry.label)).toEqual(['7x10', '10x10', '8x12', '10x12']);
    expect(catalog.entries.map((entry) => entry.sizeId)).toEqual([17, 21, 23, 25]);
  });

  it('does not publish the LED-kit size aliases', () => {
    const catalog = cncPackQueries.cncCatalog();

    for (const entry of catalog.entries) {
      expect(entry).not.toHaveProperty('sizeAliases');
    }
    // And nothing else smuggles the alias numbers through in another shape.
    expect(JSON.stringify(catalog)).not.toContain('sizeAliases');
  });

  it('flattens mixed-type option values to strings with the type they read back as', () => {
    const entry = cncPackQueries.cncCatalog().entries[3];
    const byKey = new Map(entry.manufacturingOptions.map((option) => [option.key, option]));

    expect(byKey.get('sheetStock')).toEqual({
      key: 'sheetStock',
      values: ['2440x1220', '3600x1220'],
      defaultValue: '2440x1220',
      valueType: 'string',
    });
    expect(byKey.get('tnutHoleDiameterMm')).toMatchObject({ defaultValue: '12.5', valueType: 'number' });
    expect(byKey.get('engraveHoldIds')).toMatchObject({ values: ['false', 'true'], valueType: 'boolean' });
  });

  it("reports prices as amountCents, not the service layer's priceCents", () => {
    const entry = cncPackQueries.cncCatalog().entries[0];
    expect(entry.tiers).toEqual([
      { tier: 'personal', amountCents: 14900, currency: 'AUD' },
      { tier: 'commercial_single', amountCents: 75000, currency: 'AUD' },
    ]);
  });

  it('never leaks the Stripe price env var names', () => {
    expect(JSON.stringify(cncPackQueries.cncCatalog())).not.toContain('STRIPE_PRICE');
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

  it('passes includeHoles through to the generator', async () => {
    fetchLayoutMock.mockResolvedValue({ panels: [] });

    await cncPackQueries.cncLayout(undefined, { config: config(), includeHoles: true }, anonCtx());

    expect(fetchLayoutMock).toHaveBeenCalledWith(expect.anything(), { includeHoles: true });
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
  });
});
