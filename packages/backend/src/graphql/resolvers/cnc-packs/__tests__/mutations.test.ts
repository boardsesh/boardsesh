import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

vi.mock('../../../../db/client', () => ({ db: {}, dbRead: {} }));

// See the note in queries.test.ts: the real limiter's tier-1 bucket does not
// reset between tests, so leaving it in would make test order significant.
vi.mock('../../shared/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/helpers')>()),
  applyRateLimit: vi.fn(async () => {}),
}));

const {
  validateArtworkMock,
  createPendingOrderMock,
  transitionOrderMock,
  attachCheckoutSessionMock,
  getOrderByLicenceIdMock,
  createCheckoutSessionMock,
  getAccountEmailMock,
  requireAdminMock,
  getOwnedArtAssetsMock,
  attachAssetsToOrderMock,
  releaseArtAssetsForOrderMock,
} = vi.hoisted(() => ({
  validateArtworkMock: vi.fn(),
  createPendingOrderMock: vi.fn(),
  transitionOrderMock: vi.fn(),
  attachCheckoutSessionMock: vi.fn(),
  getOrderByLicenceIdMock: vi.fn(),
  createCheckoutSessionMock: vi.fn(),
  getAccountEmailMock: vi.fn(),
  requireAdminMock: vi.fn(async () => {}),
  getOwnedArtAssetsMock: vi.fn(async () => new Map()),
  attachAssetsToOrderMock: vi.fn(async () => 0),
  releaseArtAssetsForOrderMock: vi.fn(async () => 0),
}));

vi.mock('../../../../services/cnc/worker-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/cnc/worker-client')>()),
  validateArtwork: validateArtworkMock,
}));

vi.mock('../../../../services/cnc/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/cnc/orders')>()),
  createPendingOrder: createPendingOrderMock,
  transitionOrder: transitionOrderMock,
  attachCheckoutSession: attachCheckoutSessionMock,
  getAccountEmail: getAccountEmailMock,
  getOrderByLicenceId: getOrderByLicenceIdMock,
}));

vi.mock('../../social/roles', () => ({ requireAdmin: requireAdminMock }));

// The ownership gate is a database question and `db/client` is mocked to `{}`
// here, so the lookup is stubbed and the tests assert what the resolver does
// with its answer. The row-level behaviour has its own DB-backed suite in
// `src/__tests__/cnc-art-assets.test.ts`.
vi.mock('../../../../services/cnc/art-assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/cnc/art-assets')>()),
  getOwnedArtAssets: getOwnedArtAssetsMock,
  attachAssetsToOrder: attachAssetsToOrderMock,
  releaseArtAssetsForOrder: releaseArtAssetsForOrderMock,
}));

vi.mock('../../../../services/cnc/stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/cnc/stripe')>()),
  createCheckoutSessionForOrder: createCheckoutSessionMock,
}));

import { cncPackMutations } from '../mutations';
import { CncWorkerUnavailableError, CncWorkerValidationError } from '../../../../services/cnc/worker-client';
import { CncStripeUnavailableError } from '../../../../services/cnc/stripe';

const authCtx = (): ConnectionContext => ({
  connectionId: 'conn-user-1',
  transport: 'http',
  isAuthenticated: true,
  userId: 'user-1',
});

const anonCtx = (): ConnectionContext => ({
  connectionId: 'conn-anon',
  transport: 'http',
  isAuthenticated: false,
});

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
    artwork: [
      {
        text: 'Send it',
        mode: 'engrave',
        placement: { panelIndex: 0, xMm: 600, yMm: 400, widthMm: 300, rotationDeg: 0 },
      },
    ],
    ...overrides,
  };
}

const STRIPE_ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'WEB_PUBLIC_URL',
  'BOARDSESH_URL',
  'BACKEND_PUBLIC_URL',
  'CNC_DOWNLOAD_TOKEN_SECRET',
  // The dev checkout bypass and one of the things that vetoes it. NODE_ENV is
  // typed readonly, so that one goes through vi.stubEnv instead.
  'CNC_CHECKOUT_BYPASS',
  'RAILWAY_ENVIRONMENT',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of STRIPE_ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.WEB_PUBLIC_URL = 'https://www.boardsesh.com';
  process.env.BACKEND_PUBLIC_URL = 'https://ws.boardsesh.com';
  process.env.CNC_DOWNLOAD_TOKEN_SECRET = 'grant-secret-for-tests';
  requireAdminMock.mockResolvedValue(undefined);

  delete process.env.CNC_CHECKOUT_BYPASS;
  delete process.env.RAILWAY_ENVIRONMENT;

  createPendingOrderMock.mockResolvedValue({ id: 7, licenceId: 'BS-CNC-ABC234' });
  attachCheckoutSessionMock.mockResolvedValue({ id: 7 });
  transitionOrderMock.mockResolvedValue({ id: 7, status: 'cancelled' });
  createCheckoutSessionMock.mockResolvedValue({
    sessionId: 'cs_test_1',
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
  });
  getAccountEmailMock.mockResolvedValue('account-holder@example.com');
  getOwnedArtAssetsMock.mockResolvedValue(new Map());
  attachAssetsToOrderMock.mockResolvedValue(0);
  releaseArtAssetsForOrderMock.mockResolvedValue(0);
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A well-formed checkout input; every test bends one field of it. */
function checkoutInput(overrides: Record<string, unknown> = {}) {
  return {
    config: config({ artwork: [] }),
    tier: 'personal',
    licenseeName: 'Marco de Jongh',
    licenseeEmail: 'buyer@example.com',
    acceptLicence: true,
    ...overrides,
  };
}

describe('validateCncArtwork', () => {
  it('requires authentication', async () => {
    await expect(cncPackMutations.validateCncArtwork(undefined, { config: config() }, anonCtx())).rejects.toThrow(
      /Authentication required/,
    );
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('returns the generator verdict for a valid configuration', async () => {
    const collisions = [{ artwork_index: 0, panel_index: 0, kind: 'keepout' }];
    validateArtworkMock.mockResolvedValue({ ok: false, collisions });

    await expect(cncPackMutations.validateCncArtwork(undefined, { config: config() }, authCtx())).resolves.toEqual({
      ok: false,
      collisions,
    });
  });

  it('translates the artwork into the generator contract', async () => {
    validateArtworkMock.mockResolvedValue({ ok: true, collisions: [] });

    await cncPackMutations.validateCncArtwork(undefined, { config: config() }, authCtx());

    const [, artwork] = validateArtworkMock.mock.calls[0] as [unknown, unknown[]];
    expect(artwork).toEqual([
      {
        kind: 'text',
        text: 'Send it',
        font: null,
        asset_ref: null,
        mode: 'engrave',
        placement: { panel_index: 0, x_mm: 600, y_mm: 400, width_mm: 300, rotation_deg: 0 },
      },
    ]);
  });

  it('sends an uploaded asset as kind "svg" with no font', async () => {
    validateArtworkMock.mockResolvedValue({ ok: true, collisions: [] });
    getOwnedArtAssetsMock.mockResolvedValue(
      new Map([['asset-1', { id: 'asset-1', key: 'cnc-art/user-1/a.svg', mime: 'image/svg+xml' }]]),
    );

    await cncPackMutations.validateCncArtwork(
      undefined,
      {
        config: config({
          artwork: [
            {
              assetId: 'asset-1',
              // Ignored on purpose: an SVG carries its own outlines, so a face
              // name on one is a value the generator has nowhere to apply.
              font: 'liberation-sans',
              mode: 'cut_through',
              placement: { panelIndex: 1, xMm: 300, yMm: 200, widthMm: 400, rotationDeg: -90 },
            },
          ],
        }),
      },
      authCtx(),
    );

    const [, artwork] = validateArtworkMock.mock.calls[0] as [unknown, unknown[]];
    expect(artwork).toEqual([
      {
        kind: 'svg',
        text: null,
        font: null,
        asset_ref: 'asset-1',
        mode: 'cut_through',
        placement: { panel_index: 1, x_mm: 300, y_mm: 200, width_mm: 400, rotation_deg: -90 },
      },
    ]);
  });

  it('passes a chosen font through for a label', async () => {
    validateArtworkMock.mockResolvedValue({ ok: true, collisions: [] });

    await cncPackMutations.validateCncArtwork(
      undefined,
      {
        config: config({
          artwork: [
            {
              text: 'Send it',
              font: 'liberation-sans',
              mode: 'engrave',
              placement: { panelIndex: 0, xMm: 600, yMm: 400, widthMm: 300, rotationDeg: 0 },
            },
          ],
        }),
      },
      authCtx(),
    );

    const [, artwork] = validateArtworkMock.mock.calls[0] as [unknown, { font: string | null }[]];
    expect(artwork[0].font).toBe('liberation-sans');
  });

  it('rejects a font the generator does not bundle', async () => {
    // The generator refuses an unbundled face rather than substituting one, so
    // this would otherwise be a paid order that fails at build time.
    await expect(
      cncPackMutations.validateCncArtwork(
        undefined,
        {
          config: config({
            artwork: [
              {
                text: 'Send it',
                font: 'comic-sans',
                mode: 'engrave',
                placement: { panelIndex: 0, xMm: 0, yMm: 0, widthMm: 100, rotationDeg: 0 },
              },
            ],
          }),
        },
        authCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('refuses an asset id that is not the caller’s, before asking the generator', async () => {
    // This call makes the generator FETCH the asset, so an unchecked id would
    // be a way to have Boardsesh read somebody else's upload on request.
    getOwnedArtAssetsMock.mockResolvedValue(new Map());

    await expect(
      cncPackMutations.validateCncArtwork(
        undefined,
        {
          config: config({
            artwork: [
              {
                assetId: 'someone-elses-asset',
                mode: 'engrave',
                placement: { panelIndex: 0, xMm: 0, yMm: 0, widthMm: 100, rotationDeg: 0 },
              },
            ],
          }),
        },
        authCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('fails closed when the verdict is an unrecognised shape', async () => {
    // A verdict read as "no collisions" would let unroutable artwork reach
    // checkout, which is the one outcome this call exists to prevent.
    validateArtworkMock.mockResolvedValue({ unexpected: true });

    await expect(cncPackMutations.validateCncArtwork(undefined, { config: config() }, authCtx())).resolves.toEqual({
      ok: false,
      collisions: [],
    });
  });

  it('rejects more than four artwork items before calling the generator', async () => {
    const item = {
      text: 'x',
      mode: 'engrave',
      placement: { panelIndex: 0, xMm: 0, yMm: 0, widthMm: 100, rotationDeg: 0 },
    };

    await expect(
      cncPackMutations.validateCncArtwork(undefined, { config: config({ artwork: Array(5).fill(item) }) }, authCtx()),
    ).rejects.toThrow(/at most 4 artwork items/);
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('rejects a text label over 40 characters', async () => {
    await expect(
      cncPackMutations.validateCncArtwork(
        undefined,
        {
          config: config({
            artwork: [
              {
                text: 'x'.repeat(41),
                mode: 'engrave',
                placement: { panelIndex: 0, xMm: 0, yMm: 0, widthMm: 100, rotationDeg: 0 },
              },
            ],
          }),
        },
        authCtx(),
      ),
    ).rejects.toThrow(/at most 40 characters/);
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('rejects a rotation outside -180..180', async () => {
    await expect(
      cncPackMutations.validateCncArtwork(
        undefined,
        {
          config: config({
            artwork: [
              {
                text: 'x',
                mode: 'engrave',
                placement: { panelIndex: 0, xMm: 0, yMm: 0, widthMm: 100, rotationDeg: 270 },
              },
            ],
          }),
        },
        authCtx(),
      ),
    ).rejects.toThrow(/rotationDeg/);
  });

  it('rejects a non-finite placement coordinate', async () => {
    await expect(
      cncPackMutations.validateCncArtwork(
        undefined,
        {
          config: config({
            artwork: [
              {
                text: 'x',
                mode: 'engrave',
                placement: { panelIndex: 0, xMm: Number.NaN, yMm: 0, widthMm: 100, rotationDeg: 0 },
              },
            ],
          }),
        },
        authCtx(),
      ),
    ).rejects.toThrow(/config/);
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('rejects an artwork item that is both an asset and a label', async () => {
    await expect(
      cncPackMutations.validateCncArtwork(
        undefined,
        {
          config: config({
            artwork: [
              {
                assetId: 'asset-1',
                text: 'x',
                mode: 'engrave',
                placement: { panelIndex: 0, xMm: 0, yMm: 0, widthMm: 100, rotationDeg: 0 },
              },
            ],
          }),
        },
        authCtx(),
      ),
    ).rejects.toThrow(/exactly one of assetId or text/);
  });

  it('surfaces a generator outage as CNC_WORKER_UNAVAILABLE', async () => {
    validateArtworkMock.mockRejectedValue(new CncWorkerUnavailableError('down'));

    await expect(cncPackMutations.validateCncArtwork(undefined, { config: config() }, authCtx())).rejects.toMatchObject(
      { extensions: { code: 'CNC_WORKER_UNAVAILABLE' } },
    );
  });

  it('surfaces a generator rejection as CNC_INVALID_CONFIG, not as an outage', async () => {
    validateArtworkMock.mockRejectedValue(
      new CncWorkerValidationError('ARTWORK_COLLISION', 'The label overlaps a T-nut'),
    );

    await expect(cncPackMutations.validateCncArtwork(undefined, { config: config() }, authCtx())).rejects.toMatchObject(
      { extensions: { code: 'CNC_INVALID_CONFIG' } },
    );
  });
});

describe('createCncCheckoutSession', () => {
  /** A checkout carrying one uploaded asset. */
  function checkoutWithAsset(assetId: string) {
    return checkoutInput({
      config: config({
        artwork: [
          {
            assetId,
            mode: 'engrave',
            placement: { panelIndex: 0, xMm: 600, yMm: 400, widthMm: 300, rotationDeg: 0 },
          },
        ],
      }),
    });
  }

  it('refuses an asset id the buyer does not own, before writing a row or charging', async () => {
    getOwnedArtAssetsMock.mockResolvedValue(new Map());

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutWithAsset('not-mine') }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });

    expect(createPendingOrderMock).not.toHaveBeenCalled();
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('stores the asset key and mime on the order, then stamps the order onto the asset', async () => {
    getOwnedArtAssetsMock.mockResolvedValue(
      new Map([['asset-1', { id: 'asset-1', key: 'cnc-art/user-1/asset-1.svg', mime: 'image/svg+xml' }]]),
    );
    validateArtworkMock.mockResolvedValue({ ok: true, collisions: [] });
    attachAssetsToOrderMock.mockResolvedValue(1);

    await cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutWithAsset('asset-1') }, authCtx());

    const [orderInput] = createPendingOrderMock.mock.calls[0] as [{ artwork: Record<string, unknown>[] }];
    // The key and mime are copied ONTO the order because the asset row
    // cascades away with its uploader's account while the licence survives.
    expect(orderInput.artwork).toEqual([
      {
        assetId: 'asset-1',
        assetKey: 'cnc-art/user-1/asset-1.svg',
        mime: 'image/svg+xml',
        text: null,
        font: null,
        mode: 'engrave',
        placement: { panelIndex: 0, xMm: 600, yMm: 400, widthMm: 300, rotationDeg: 0 },
      },
    ]);
    expect(attachAssetsToOrderMock).toHaveBeenCalledWith(7, 'user-1', ['asset-1']);
  });

  it('cancels the order and refuses checkout when an asset fails to attach', async () => {
    // Ownership was already checked by resolveArtworkAssets above, so an
    // attach that comes back short is a race — the asset stopped being this
    // buyer's, or another order claimed it — between that check and this
    // write. Charging for a pack whose artwork we never actually bound to it
    // is worse than refusing the checkout.
    getOwnedArtAssetsMock.mockResolvedValue(
      new Map([['asset-1', { id: 'asset-1', key: 'cnc-art/user-1/asset-1.svg', mime: 'image/svg+xml' }]]),
    );
    validateArtworkMock.mockResolvedValue({ ok: true, collisions: [] });
    attachAssetsToOrderMock.mockResolvedValue(0);

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutWithAsset('asset-1') }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });

    expect(transitionOrderMock).toHaveBeenCalledWith(7, 'checkoutFailed');
    // A partial attach stamped whatever it did claim; those rows go back to
    // the buyer with the order they were claimed for.
    expect(releaseArtAssetsForOrderMock).toHaveBeenCalledWith(7);
  });

  it('cancels the order and refuses checkout when stamping the asset throws', async () => {
    getOwnedArtAssetsMock.mockResolvedValue(
      new Map([['asset-1', { id: 'asset-1', key: 'cnc-art/user-1/asset-1.svg', mime: 'image/svg+xml' }]]),
    );
    validateArtworkMock.mockResolvedValue({ ok: true, collisions: [] });
    attachAssetsToOrderMock.mockRejectedValue(new Error('db went away'));

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutWithAsset('asset-1') }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });

    expect(transitionOrderMock).toHaveBeenCalledWith(7, 'checkoutFailed');
  });

  it('hands the artwork back when Stripe will not open a session, so the buyer can retry', async () => {
    // The stamp goes on before Stripe is asked for anything. Leaving it there
    // would bind the upload to an order nobody will ever pay for, and
    // `attachAssetsToOrder` skips an asset that already carries an order id —
    // so the buyer's next checkout would fail the same way forever.
    getOwnedArtAssetsMock.mockResolvedValue(
      new Map([['asset-1', { id: 'asset-1', key: 'cnc-art/user-1/asset-1.svg', mime: 'image/svg+xml' }]]),
    );
    validateArtworkMock.mockResolvedValue({ ok: true, collisions: [] });
    attachAssetsToOrderMock.mockResolvedValue(1);
    createCheckoutSessionMock.mockRejectedValue(new CncStripeUnavailableError('Stripe is down'));

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutWithAsset('asset-1') }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });

    expect(transitionOrderMock).toHaveBeenCalledWith(7, 'checkoutFailed');
    expect(releaseArtAssetsForOrderMock).toHaveBeenCalledWith(7);
  });

  it('requires authentication', async () => {
    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, anonCtx()),
    ).rejects.toThrow(/Authentication required/);
    expect(createPendingOrderMock).not.toHaveBeenCalled();
  });

  it('reserves an order and returns the hosted checkout URL', async () => {
    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx()),
    ).resolves.toEqual({
      orderId: '7',
      licenceId: 'BS-CNC-ABC234',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });

    const [orderInput] = createPendingOrderMock.mock.calls[0] as [Record<string, unknown>];
    // Written in pending_payment with the catalogue's price — never queued
    // here. `pending_payment -> queued` happens in the paid webhook alone.
    expect(orderInput).toMatchObject({
      userId: 'user-1',
      tier: 'personal',
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 25,
      amountCents: 14900,
      currency: 'AUD',
      licenseeEmail: 'buyer@example.com',
    });
    expect(attachCheckoutSessionMock).toHaveBeenCalledWith(7, 'cs_test_1');

    const [sessionInput] = createCheckoutSessionMock.mock.calls[0] as [
      { successUrl: string; cancelUrl: string; customerEmail: string },
    ];
    expect(sessionInput.successUrl).toBe('https://www.boardsesh.com/build-plans/orders/BS-CNC-ABC234?checkout=success');
    expect(sessionInput.cancelUrl).toBe(
      'https://www.boardsesh.com/build-plans/orders/BS-CNC-ABC234?checkout=cancelled',
    );
    // Stripe's customer_email is the signed-in account's own email, never the
    // buyer-typed licenseeEmail — even though they differ here on purpose.
    expect(sessionInput.customerEmail).toBe('account-holder@example.com');
    expect(getAccountEmailMock).toHaveBeenCalledWith('user-1');
  });

  it('refuses an order when the licence was not accepted', async () => {
    await expect(
      cncPackMutations.createCncCheckoutSession(
        undefined,
        { input: checkoutInput({ acceptLicence: false }) },
        authCtx(),
      ),
    ).rejects.toThrow(/accept the manufacturing licence/);
    expect(createPendingOrderMock).not.toHaveBeenCalled();
  });

  it('refuses a commercial licence with no named installation', async () => {
    // Without the site name a commercial single-build licence is just a more
    // expensive personal one, and the licence record says nothing useful.
    await expect(
      cncPackMutations.createCncCheckoutSession(
        undefined,
        { input: checkoutInput({ tier: 'commercial_single' }) },
        authCtx(),
      ),
    ).rejects.toThrow(/one named installation/);
    expect(createPendingOrderMock).not.toHaveBeenCalled();
  });

  it('accepts a commercial licence that names its installation', async () => {
    await expect(
      cncPackMutations.createCncCheckoutSession(
        undefined,
        { input: checkoutInput({ tier: 'commercial_single', customerSiteName: 'Northside Climbing' }) },
        authCtx(),
      ),
    ).resolves.toMatchObject({ licenceId: 'BS-CNC-ABC234' });

    const [orderInput] = createPendingOrderMock.mock.calls[0] as [{ tier: string; customerSiteName: string | null }];
    expect(orderInput).toMatchObject({ tier: 'commercial_single', customerSiteName: 'Northside Climbing' });
  });

  it('treats an empty site name on a personal licence as no site name', async () => {
    // A configurator that keeps the field mounted after a tier switch submits
    // "", which is an empty field rather than a value.
    await expect(
      cncPackMutations.createCncCheckoutSession(
        undefined,
        { input: checkoutInput({ customerSiteName: '  ' }) },
        authCtx(),
      ),
    ).resolves.toMatchObject({ licenceId: 'BS-CNC-ABC234' });

    const [orderInput] = createPendingOrderMock.mock.calls[0] as [{ customerSiteName: string | null }];
    expect(orderInput.customerSiteName).toBeNull();
  });

  it('refuses a personal licence that names a customer site', async () => {
    await expect(
      cncPackMutations.createCncCheckoutSession(
        undefined,
        { input: checkoutInput({ customerSiteName: 'Northside Climbing' }) },
        authCtx(),
      ),
    ).rejects.toThrow(/commercial tier/);
  });

  it('refuses a board that is not on sale, before writing anything', async () => {
    await expect(
      cncPackMutations.createCncCheckoutSession(
        undefined,
        { input: checkoutInput({ config: config({ sizeId: 999, artwork: [] }) }) },
        authCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });
    expect(createPendingOrderMock).not.toHaveBeenCalled();
  });

  it('refuses to take an order when Stripe is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });
    expect(createPendingOrderMock).not.toHaveBeenCalled();
  });

  it('will not sell artwork the generator says does not fit', async () => {
    validateArtworkMock.mockResolvedValue({ ok: false, collisions: [{ artwork_index: 0, kind: 'keepout' }] });

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput({ config: config() }) }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });
    expect(createPendingOrderMock).not.toHaveBeenCalled();
  });

  it('does not call the generator when there is no artwork', async () => {
    await cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx());
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('cancels the reserved order and reports CNC_CHECKOUT_UNAVAILABLE when Stripe fails', async () => {
    createCheckoutSessionMock.mockRejectedValue(new CncStripeUnavailableError('Stripe is down'));

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });

    // Without a session there is no `checkout.session.expired` to cancel the
    // row, so it would sit in the buyer's order list forever.
    expect(transitionOrderMock).toHaveBeenCalledWith(7, 'checkoutFailed');
  });

  it('still returns the checkout URL when the session id could not be attached', async () => {
    // The session id is a support convenience; the webhook finds the order by
    // metadata regardless, so losing it must not cost the buyer their checkout.
    attachCheckoutSessionMock.mockResolvedValue(null);

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx()),
    ).resolves.toMatchObject({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  });

  it('falls back to the licensee email for Stripe when the account has none on file', async () => {
    getAccountEmailMock.mockResolvedValue(null);

    await cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx());

    const [sessionInput] = createCheckoutSessionMock.mock.calls[0] as [{ customerEmail: string }];
    expect(sessionInput.customerEmail).toBe('buyer@example.com');
  });
});

/** A ready, downloadable order owned by `user-1`. */
function readyOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    licenceId: 'BS-CNC-ABC234',
    userId: 'user-1',
    tier: 'personal',
    status: 'ready',
    refundedAt: null,
    generation: 1,
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: DEFAULT_OPTIONS,
    artwork: null,
    licenseeName: 'Marco',
    customerSiteName: null,
    amountCents: 14900,
    currency: 'AUD',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    paidAt: new Date('2026-09-01T00:00:00Z'),
    generatedAt: new Date('2026-09-01T00:05:00Z'),
    zipSizeBytes: 4096,
    downloadCount: 0,
    lastDownloadedAt: null,
    ...overrides,
  };
}

describe('createCncDownloadGrant', () => {
  it('requires authentication', async () => {
    await expect(
      cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'BS-CNC-ABC234' }, anonCtx()),
    ).rejects.toThrow(/Authentication required/);
    expect(getOrderByLicenceIdMock).not.toHaveBeenCalled();
  });

  it('mints a link to the caller’s own ready pack', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder());

    const grant = await cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx());

    expect(grant.url).toMatch(
      /^https:\/\/ws\.boardsesh\.com\/api\/cnc\/packs\/BS-CNC-ABC234\/download\?token=[A-Za-z0-9._~%-]+$/,
    );
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('refuses somebody else’s licence the same way it refuses one that does not exist', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder({ userId: 'someone-else' }));
    const theirs = cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx());
    await expect(theirs).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });

    getOrderByLicenceIdMock.mockResolvedValue(null);
    const missing = cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx());
    await expect(missing).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('will not mint a grant for a pack that is not ready', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder({ status: 'generating' }));

    await expect(
      cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_PACK_NOT_DOWNLOADABLE' } });
  });

  it('will not mint a grant for a refunded order', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder({ refundedAt: new Date() }));

    await expect(
      cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_PACK_NOT_DOWNLOADABLE' } });
  });

  it('rejects a malformed licence id before touching the database', async () => {
    await expect(
      cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'not-a-licence' }, authCtx()),
    ).rejects.toThrow();
    expect(getOrderByLicenceIdMock).not.toHaveBeenCalled();
  });
});

describe('regenerateCncPack', () => {
  it('requires an admin', async () => {
    requireAdminMock.mockRejectedValue(new Error('Admin access required'));

    await expect(
      cncPackMutations.regenerateCncPack(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx()),
    ).rejects.toThrow(/Admin access required/);
    expect(getOrderByLicenceIdMock).not.toHaveBeenCalled();
  });

  it('requeues a ready pack with the generation bumped and the attempt budget reset', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder({ generation: 2 }));
    transitionOrderMock.mockResolvedValue(readyOrder({ status: 'queued', generation: 3, zipSizeBytes: null }));

    const result = await cncPackMutations.regenerateCncPack(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx());

    expect(transitionOrderMock).toHaveBeenCalledWith(
      7,
      'regenerate',
      expect.objectContaining({ generation: 3, attempts: 0, claimToken: null, lastError: null }),
    );
    expect(result.status).toBe('queued');
  });

  it('refuses an order the state machine will not requeue', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder({ status: 'pending_payment' }));
    // Zero rows back: `regenerate` is only legal from ready/failed.
    transitionOrderMock.mockResolvedValue(null);

    await expect(
      cncPackMutations.regenerateCncPack(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_PACK_NOT_DOWNLOADABLE' } });
  });
});

describe('createCncCheckoutSession with the dev checkout bypass', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The bypass's own precondition: it refuses to run where a card can be charged. */
  function enableBypass(): void {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.CNC_CHECKOUT_BYPASS = '1';
  }

  const ORDER_PAGE_URL = 'https://www.boardsesh.com/build-plans/orders/BS-CNC-ABC234';

  it('queues the order at the catalogue price and returns the order page', async () => {
    enableBypass();
    transitionOrderMock.mockResolvedValue({ id: 7, status: 'queued' });

    const result = await cncPackMutations.createCncCheckoutSession(
      undefined,
      { input: checkoutInput({ tier: 'personal' }) },
      authCtx(),
    );

    // Stripe is not asked for anything at all.
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    expect(attachCheckoutSessionMock).not.toHaveBeenCalled();

    expect(transitionOrderMock).toHaveBeenCalledWith(7, 'checkoutCompleted', {
      paidAt: expect.any(Date),
      queuedAt: expect.any(Date),
      // The personal tier's catalogue price, since there is no charge to read.
      amountCents: 14900,
      currency: 'AUD',
      stripeCheckoutSessionId: 'bypass-BS-CNC-ABC234',
      stripePaymentIntentId: null,
    });

    expect(result).toEqual({
      orderId: '7',
      licenceId: 'BS-CNC-ABC234',
      checkoutUrl: `${ORDER_PAGE_URL}?checkout=success`,
    });
  });

  it('prices the commercial tier from the catalogue too', async () => {
    enableBypass();
    transitionOrderMock.mockResolvedValue({ id: 7, status: 'queued' });

    await cncPackMutations.createCncCheckoutSession(
      undefined,
      // A commercial licence names the installation it covers.
      { input: checkoutInput({ tier: 'commercial_single', customerSiteName: 'Northside Climbing' }) },
      authCtx(),
    );

    expect(transitionOrderMock).toHaveBeenCalledWith(
      7,
      'checkoutCompleted',
      expect.objectContaining({ amountCents: 75000 }),
    );
  });

  it('refuses the checkout when the order it just created will not queue', async () => {
    // Zero rows back means the state machine and the bypass disagree. Handing
    // the buyer an order-page URL for an order still sitting in
    // `pending_payment` would look like a purchase that silently did nothing.
    enableBypass();
    transitionOrderMock.mockResolvedValue(null);

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });
  });

  it('is off in production, even with the env var set', async () => {
    // NODE_ENV is the hard guard: a production process with this variable
    // inherited from somewhere must take the real path, which here means
    // refusing outright because there is no Stripe key.
    enableBypass();
    vi.stubEnv('NODE_ENV', 'production');

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });

    expect(createPendingOrderMock).not.toHaveBeenCalled();
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('takes the real Stripe path in production when Stripe is configured', async () => {
    process.env.CNC_CHECKOUT_BYPASS = '1';
    vi.stubEnv('NODE_ENV', 'production');
    process.env.STRIPE_SECRET_KEY = 'sk_live_not_really';

    const result = await cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx());

    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('is ignored whenever a Stripe secret key is present', async () => {
    // The condition that makes "bypass" and "charging people" mutually
    // exclusive: a stack that can take a payment never fakes one, dev or not.
    process.env.CNC_CHECKOUT_BYPASS = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

    const result = await cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx());

    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('is off on a deployed Railway service', async () => {
    // Railway prod leaves NODE_ENV unset, so the environment variable is the
    // only thing that says "this is a deploy, not a laptop".
    enableBypass();
    process.env.RAILWAY_ENVIRONMENT = 'production';

    await expect(
      cncPackMutations.createCncCheckoutSession(undefined, { input: checkoutInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });

    expect(transitionOrderMock).not.toHaveBeenCalled();
  });
});
