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
  createPreviewOrderMock,
  findPreviewOrderByConfigHashMock,
  countOrdersCreatedSinceMock,
  transitionOrderMock,
  attachCheckoutSessionMock,
  getOrderByIdMock,
  getOrderByLicenceIdMock,
  createCheckoutSessionMock,
  getAccountEmailMock,
  requireAdminMock,
  getOwnedArtAssetsMock,
  attachAssetsToOrderMock,
  releaseArtAssetsForOrderMock,
} = vi.hoisted(() => ({
  validateArtworkMock: vi.fn(),
  createPreviewOrderMock: vi.fn(),
  findPreviewOrderByConfigHashMock: vi.fn(),
  countOrdersCreatedSinceMock: vi.fn(),
  transitionOrderMock: vi.fn(),
  attachCheckoutSessionMock: vi.fn(),
  getOrderByIdMock: vi.fn(),
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
  createPreviewOrder: createPreviewOrderMock,
  findPreviewOrderByConfigHash: findPreviewOrderByConfigHashMock,
  countOrdersCreatedSince: countOrdersCreatedSinceMock,
  transitionOrder: transitionOrderMock,
  attachCheckoutSession: attachCheckoutSessionMock,
  getAccountEmail: getAccountEmailMock,
  getOrderById: getOrderByIdMock,
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

  createPreviewOrderMock.mockResolvedValue(previewOrder({ status: 'preview_queued' }));
  findPreviewOrderByConfigHashMock.mockResolvedValue(null);
  countOrdersCreatedSinceMock.mockResolvedValue(0);
  attachCheckoutSessionMock.mockResolvedValue({ id: 7 });
  getOrderByIdMock.mockResolvedValue(previewOrder());
  transitionOrderMock.mockResolvedValue(previewOrder({ status: 'pending_payment', tier: 'personal' }));
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

/** A well-formed finalise input; every test bends one field of it. */
function finaliseInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: '7',
    tier: 'personal',
    licenseeName: 'Marco de Jongh',
    licenseeEmail: 'buyer@example.com',
    acceptLicence: true,
    ...overrides,
  };
}

/** The order row a finalise acts on: this buyer's own, ready to be bought. */
function previewOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    licenceId: 'BS-CNC-ABC234',
    userId: 'user-1',
    tier: null,
    status: 'preview_ready',
    refundedAt: null,
    generation: 1,
    attempts: 1,
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: DEFAULT_OPTIONS,
    artwork: null,
    configHash: 'abc123',
    licenseeName: null,
    customerSiteName: null,
    amountCents: null,
    currency: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    paidAt: null,
    generatedAt: null,
    previewGeneratedAt: new Date('2026-09-01T00:02:00Z'),
    previewKeys: null,
    previewZipSizeBytes: 2048,
    previewsGenerated: 1,
    zipSizeBytes: null,
    downloadCount: 0,
    lastDownloadedAt: null,
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

describe('createCncPreview', () => {
  /** A configuration carrying one uploaded asset. */
  function configWithAsset(assetId: string) {
    return config({
      artwork: [
        {
          assetId,
          mode: 'engrave',
          placement: { panelIndex: 0, xMm: 600, yMm: 400, widthMm: 300, rotationDeg: 0 },
        },
      ],
    });
  }

  it('requires authentication', async () => {
    await expect(
      cncPackMutations.createCncPreview(undefined, { config: config({ artwork: [] }) }, anonCtx()),
    ).rejects.toThrow(/Authentication required/);
    expect(createPreviewOrderMock).not.toHaveBeenCalled();
  });

  it('queues a free preview with no tier, no licensee and no price', async () => {
    const order = await cncPackMutations.createCncPreview(undefined, { config: config({ artwork: [] }) }, authCtx());

    expect(order).toMatchObject({ id: '7', licenceId: 'BS-CNC-ABC234', status: 'preview_queued', tier: null });

    const [orderInput] = createPreviewOrderMock.mock.calls[0] as [Record<string, unknown>];
    expect(orderInput).toMatchObject({ userId: 'user-1', boardName: 'kilter', layoutId: 8, sizeId: 25 });
    // Nothing about a sale is written here — those columns do not even exist on
    // the input.
    expect(orderInput).not.toHaveProperty('tier');
    expect(orderInput).not.toHaveProperty('licenseeName');
    expect(orderInput).not.toHaveProperty('amountCents');
    expect(orderInput.configHash).toMatch(/^[0-9a-f]{64}$/);
    // A preview never touches Stripe.
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('hands back the preview it already made for this configuration rather than queueing a second', async () => {
    findPreviewOrderByConfigHashMock.mockResolvedValue(previewOrder({ status: 'preview_generating' }));

    const order = await cncPackMutations.createCncPreview(undefined, { config: config({ artwork: [] }) }, authCtx());

    expect(order).toMatchObject({ id: '7', status: 'preview_generating' });
    expect(createPreviewOrderMock).not.toHaveBeenCalled();
    // And it must not spend a slot in the hourly budget: polling a queued
    // preview by re-asking for it is the intended client behaviour.
    expect(countOrdersCreatedSinceMock).not.toHaveBeenCalled();
  });

  it('gives the same configuration the same hash whatever order its options arrive in', async () => {
    await cncPackMutations.createCncPreview(undefined, { config: config({ artwork: [] }) }, authCtx());
    const [first] = createPreviewOrderMock.mock.calls[0] as [{ configHash: string }];

    const reorderedOptions = Object.fromEntries(Object.entries(DEFAULT_OPTIONS).reverse());
    await cncPackMutations.createCncPreview(
      undefined,
      { config: { ...config({ artwork: [] }), options: reorderedOptions } },
      authCtx(),
    );
    const [second] = createPreviewOrderMock.mock.calls[1] as [{ configHash: string }];

    expect(second.configHash).toBe(first.configHash);
  });

  it('gives a changed configuration a different hash, so it becomes a new preview', async () => {
    await cncPackMutations.createCncPreview(undefined, { config: config({ artwork: [] }) }, authCtx());
    const [first] = createPreviewOrderMock.mock.calls[0] as [{ configHash: string }];

    await cncPackMutations.createCncPreview(
      undefined,
      { config: config({ artwork: [], options: { ...DEFAULT_OPTIONS, paper: 'TABLOID' } }) },
      authCtx(),
    );
    const [second] = createPreviewOrderMock.mock.calls[1] as [{ configHash: string }];

    expect(second.configHash).not.toBe(first.configHash);
  });

  it('refuses a fifth preview in an hour', async () => {
    countOrdersCreatedSinceMock.mockResolvedValue(4);

    await expect(
      cncPackMutations.createCncPreview(undefined, { config: config({ artwork: [] }) }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED', operation: 'createCncPreview' } });

    expect(createPreviewOrderMock).not.toHaveBeenCalled();
    // Refused before the generator is asked to check anything, so a script
    // cannot use the ceiling as a way to keep the worker busy.
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('lets the fourth preview of the hour through', async () => {
    countOrdersCreatedSinceMock.mockResolvedValue(3);

    await expect(
      cncPackMutations.createCncPreview(undefined, { config: config({ artwork: [] }) }, authCtx()),
    ).resolves.toMatchObject({ licenceId: 'BS-CNC-ABC234' });
  });

  it('refuses a board that is not on sale, before writing anything', async () => {
    await expect(
      cncPackMutations.createCncPreview(undefined, { config: config({ sizeId: 999, artwork: [] }) }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });
    expect(createPreviewOrderMock).not.toHaveBeenCalled();
  });

  it('refuses an asset id the buyer does not own, before writing a row', async () => {
    getOwnedArtAssetsMock.mockResolvedValue(new Map());

    await expect(
      cncPackMutations.createCncPreview(undefined, { config: configWithAsset('not-mine') }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });

    expect(createPreviewOrderMock).not.toHaveBeenCalled();
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });

  it('stores the asset key and mime on the order', async () => {
    getOwnedArtAssetsMock.mockResolvedValue(
      new Map([['asset-1', { id: 'asset-1', key: 'cnc-art/user-1/asset-1.svg', mime: 'image/svg+xml' }]]),
    );
    validateArtworkMock.mockResolvedValue({ ok: true, collisions: [] });

    await cncPackMutations.createCncPreview(undefined, { config: configWithAsset('asset-1') }, authCtx());

    const [orderInput] = createPreviewOrderMock.mock.calls[0] as [{ artwork: Record<string, unknown>[] }];
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
    // Nothing is stamped onto the asset yet: a preview is not a sale, and one
    // upload legitimately appears in several previews of the same wall.
    expect(attachAssetsToOrderMock).not.toHaveBeenCalled();
  });

  it('will not preview artwork the generator says does not fit', async () => {
    validateArtworkMock.mockResolvedValue({ ok: false, collisions: [{ artwork_index: 0, kind: 'keepout' }] });

    await expect(cncPackMutations.createCncPreview(undefined, { config: config() }, authCtx())).rejects.toMatchObject({
      extensions: { code: 'CNC_INVALID_CONFIG' },
    });
    expect(createPreviewOrderMock).not.toHaveBeenCalled();
  });

  it('does not call the generator when there is no artwork', async () => {
    await cncPackMutations.createCncPreview(undefined, { config: config({ artwork: [] }) }, authCtx());
    expect(validateArtworkMock).not.toHaveBeenCalled();
  });
});

describe('finaliseCncOrder', () => {
  it('requires authentication', async () => {
    await expect(cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, anonCtx())).rejects.toThrow(
      /Authentication required/,
    );
    expect(getOrderByIdMock).not.toHaveBeenCalled();
  });

  it('attaches the licence to the previewed order and returns the hosted checkout URL', async () => {
    await expect(cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx())).resolves.toEqual({
      orderId: '7',
      licenceId: 'BS-CNC-ABC234',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });

    // The configuration is never re-submitted: the row already carries the wall
    // the buyer approved, so nothing here can change what they are buying.
    expect(createPreviewOrderMock).not.toHaveBeenCalled();
    expect(transitionOrderMock).toHaveBeenCalledWith(
      7,
      'finalise',
      expect.objectContaining({
        tier: 'personal',
        licenseeName: 'Marco de Jongh',
        licenseeEmail: 'buyer@example.com',
        amountCents: 14900,
        currency: 'AUD',
        // The pack gets its own attempt budget rather than inheriting whatever
        // the preview spent.
        attempts: 0,
        claimToken: null,
      }),
    );
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

  it('refuses somebody else’s order the same way it refuses one that does not exist', async () => {
    getOrderByIdMock.mockResolvedValue(previewOrder({ userId: 'someone-else' }));
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });

    getOrderByIdMock.mockResolvedValue(null);
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });

    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it.each(['preview_queued', 'preview_generating', 'preview_failed', 'queued', 'ready', 'cancelled'])(
    'refuses to sell a %s order — only a finished preview can be bought',
    async (status) => {
      getOrderByIdMock.mockResolvedValue(previewOrder({ status }));

      await expect(
        cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
      ).rejects.toMatchObject({ extensions: { code: 'CNC_ORDER_NOT_FINALISABLE', status } });

      expect(transitionOrderMock).not.toHaveBeenCalled();
      expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    },
  );

  it('refuses when another tab already finalised the order', async () => {
    // The read said `preview_ready`, the conditional UPDATE disagreed.
    transitionOrderMock.mockResolvedValue(null);

    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_ORDER_NOT_FINALISABLE' } });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('refuses an order when the licence was not accepted', async () => {
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput({ acceptLicence: false }) }, authCtx()),
    ).rejects.toThrow(/accept the manufacturing licence/);
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('refuses a commercial licence with no named installation', async () => {
    // Without the site name a commercial single-build licence is just a more
    // expensive personal one, and the licence record says nothing useful.
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput({ tier: 'commercial_single' }) }, authCtx()),
    ).rejects.toThrow(/one named installation/);
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('accepts a commercial licence that names its installation, at the commercial price', async () => {
    await expect(
      cncPackMutations.finaliseCncOrder(
        undefined,
        { input: finaliseInput({ tier: 'commercial_single', customerSiteName: 'Northside Climbing' }) },
        authCtx(),
      ),
    ).resolves.toMatchObject({ licenceId: 'BS-CNC-ABC234' });

    expect(transitionOrderMock).toHaveBeenCalledWith(
      7,
      'finalise',
      expect.objectContaining({
        tier: 'commercial_single',
        customerSiteName: 'Northside Climbing',
        amountCents: 75000,
      }),
    );
  });

  it('treats an empty site name on a personal licence as no site name', async () => {
    // A configurator that keeps the field mounted after a tier switch submits
    // "", which is an empty field rather than a value.
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput({ customerSiteName: '  ' }) }, authCtx()),
    ).resolves.toMatchObject({ licenceId: 'BS-CNC-ABC234' });

    expect(transitionOrderMock).toHaveBeenCalledWith(
      7,
      'finalise',
      expect.objectContaining({ customerSiteName: null }),
    );
  });

  it('refuses a personal licence that names a customer site', async () => {
    await expect(
      cncPackMutations.finaliseCncOrder(
        undefined,
        { input: finaliseInput({ customerSiteName: 'Northside Climbing' }) },
        authCtx(),
      ),
    ).rejects.toThrow(/commercial tier/);
  });

  it('refuses to take an order when Stripe is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;

    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('refuses a wall the catalogue no longer sells', async () => {
    getOrderByIdMock.mockResolvedValue(previewOrder({ sizeId: 999 }));

    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('returns the order to its preview when Stripe will not open a session', async () => {
    // `cancelled` would throw away a perfectly good preview because of our
    // outage — and cost the buyer a slot in the hourly budget to make another.
    createCheckoutSessionMock.mockRejectedValue(new CncStripeUnavailableError('Stripe is down'));

    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });

    expect(transitionOrderMock).toHaveBeenCalledWith(7, 'finaliseFailed');
    expect(releaseArtAssetsForOrderMock).toHaveBeenCalledWith(7);
  });

  it('stamps the sale onto the uploads it names', async () => {
    transitionOrderMock.mockResolvedValue(
      previewOrder({ status: 'pending_payment', artwork: [{ assetId: 'asset-1', assetKey: 'k', mime: 'm' }] }),
    );
    attachAssetsToOrderMock.mockResolvedValue(1);

    await cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx());

    expect(attachAssetsToOrderMock).toHaveBeenCalledWith(7, 'user-1', ['asset-1']);
  });

  it('still sells the pack when the upload was already stamped by an earlier order', async () => {
    // One upload can appear in several orders now — every preview iteration is
    // a row of its own, and a buyer may build two walls with the same logo. The
    // stamp is a cleanup marker, not an exclusive claim, and ownership was
    // proven when the preview row was written.
    transitionOrderMock.mockResolvedValue(
      previewOrder({ status: 'pending_payment', artwork: [{ assetId: 'asset-1', assetKey: 'k', mime: 'm' }] }),
    );
    attachAssetsToOrderMock.mockResolvedValue(0);

    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).resolves.toMatchObject({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  });

  it('still returns the checkout URL when the session id could not be attached', async () => {
    // The session id is a support convenience; the webhook finds the order by
    // metadata regardless, so losing it must not cost the buyer their checkout.
    attachCheckoutSessionMock.mockResolvedValue(null);

    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).resolves.toMatchObject({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  });

  it('falls back to the licensee email for Stripe when the account has none on file', async () => {
    getAccountEmailMock.mockResolvedValue(null);

    await cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx());

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
      /^https:\/\/ws\.boardsesh\.com\/api\/cnc\/packs\/BS-CNC-ABC234\/download\?kind=full&token=[A-Za-z0-9._~%-]+$/,
    );
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('mints a preview link for an order that has only been previewed', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder({ status: 'preview_ready' }));

    const grant = await cncPackMutations.createCncDownloadGrant(
      undefined,
      { licenceId: 'BS-CNC-ABC234', kind: 'PREVIEW' },
      authCtx(),
    );

    expect(grant.url).toContain('kind=preview');
  });

  it('will not mint a FULL grant for an order that has only been previewed', async () => {
    // The one thing the two kinds must not blur: a preview being ready is not
    // the DXFs being paid for.
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder({ status: 'preview_ready' }));

    await expect(
      cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'BS-CNC-ABC234' }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_PACK_NOT_DOWNLOADABLE', status: 'preview_ready' } });
  });

  it('still serves the preview after the pack has been bought and built', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder({ status: 'ready' }));

    await expect(
      cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'BS-CNC-ABC234', kind: 'PREVIEW' }, authCtx()),
    ).resolves.toMatchObject({ url: expect.stringContaining('kind=preview') });
  });

  it('will not mint a preview grant while the preview is still generating', async () => {
    getOrderByLicenceIdMock.mockResolvedValue(readyOrder({ status: 'preview_generating' }));

    await expect(
      cncPackMutations.createCncDownloadGrant(undefined, { licenceId: 'BS-CNC-ABC234', kind: 'PREVIEW' }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_PACK_NOT_DOWNLOADABLE' } });
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

describe('finaliseCncOrder with the dev checkout bypass', () => {
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
    transitionOrderMock.mockResolvedValue(previewOrder({ status: 'pending_payment', tier: 'personal' }));

    const result = await cncPackMutations.finaliseCncOrder(
      undefined,
      { input: finaliseInput({ tier: 'personal' }) },
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

    await cncPackMutations.finaliseCncOrder(
      undefined,
      // A commercial licence names the installation it covers.
      { input: finaliseInput({ tier: 'commercial_single', customerSiteName: 'Northside Climbing' }) },
      authCtx(),
    );

    expect(transitionOrderMock).toHaveBeenCalledWith(
      7,
      'checkoutCompleted',
      expect.objectContaining({ amountCents: 75000 }),
    );
  });

  it('refuses the checkout when the order it just finalised will not queue', async () => {
    // Zero rows back means the state machine and the bypass disagree. Handing
    // the buyer an order-page URL for an order still sitting in
    // `pending_payment` would look like a purchase that silently did nothing.
    enableBypass();
    transitionOrderMock.mockImplementation(async (_id: number, event: string) =>
      event === 'finalise' ? previewOrder({ status: 'pending_payment' }) : null,
    );

    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });
  });

  it('is off in production, even with the env var set', async () => {
    // NODE_ENV is the hard guard: a production process with this variable
    // inherited from somewhere must take the real path, which here means
    // refusing outright because there is no Stripe key.
    enableBypass();
    vi.stubEnv('NODE_ENV', 'production');

    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });

    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('takes the real Stripe path in production when Stripe is configured', async () => {
    process.env.CNC_CHECKOUT_BYPASS = '1';
    vi.stubEnv('NODE_ENV', 'production');
    process.env.STRIPE_SECRET_KEY = 'sk_live_not_really';

    const result = await cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx());

    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    // `finalise` and nothing else: the bypass's own `checkoutCompleted` is the
    // transition that must not have happened.
    expect(transitionOrderMock).toHaveBeenCalledTimes(1);
    expect(transitionOrderMock).toHaveBeenCalledWith(7, 'finalise', expect.anything());
  });

  it('is ignored whenever a Stripe secret key is present', async () => {
    // The condition that makes "bypass" and "charging people" mutually
    // exclusive: a stack that can take a payment never fakes one, dev or not.
    process.env.CNC_CHECKOUT_BYPASS = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

    const result = await cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx());

    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(transitionOrderMock).toHaveBeenCalledTimes(1);
  });

  it('is off on a deployed Railway service', async () => {
    // Railway prod leaves NODE_ENV unset, so the environment variable is the
    // only thing that says "this is a deploy, not a laptop".
    enableBypass();
    process.env.RAILWAY_ENVIRONMENT = 'production';

    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });

    expect(transitionOrderMock).not.toHaveBeenCalled();
  });
});
