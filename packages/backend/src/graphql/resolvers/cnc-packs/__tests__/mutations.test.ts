import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { CncOrder } from '@boardsesh/db/schema';
import { buildWorkerJob } from '../../../../services/cnc/job-payload';

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
  supportStrips: true,
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
  vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs');
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
  transitionOrderMock.mockResolvedValue(previewOrder({ status: 'queued', tier: 'personal' }));
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
  vi.unstubAllEnvs();
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
  it('refuses preview work while the PostHog flag is off', async () => {
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs=false');
    await expect(cncPackMutations.createCncPreview(undefined, { config: config() }, authCtx())).rejects.toMatchObject({
      extensions: { code: 'CNC_WORKER_UNAVAILABLE' },
    });
    expect(findPreviewOrderByConfigHashMock).not.toHaveBeenCalled();
    expect(createPreviewOrderMock).not.toHaveBeenCalled();
  });

  it.each([
    [14, false],
    [8, false],
    [8, true],
    [10, false],
    [10, true],
    [28, false],
    [28, true],
  ] as const)(
    'persists OG size %i kicker inclusion %s through the claimed worker job',
    async (sizeId, includeKicker) => {
      await cncPackMutations.createCncPreview(
        undefined,
        {
          config: config({ layoutId: 1, sizeId, setIds: '1,20', options: { includeKicker }, artwork: [] }),
        },
        authCtx(),
      );
      const [orderInput] = createPreviewOrderMock.mock.calls[0] as [Record<string, unknown>];
      expect(orderInput).toMatchObject({
        layoutId: 1,
        sizeId,
        setIds: '1,20',
        options: { includeKicker, ledHoleDiameterMm: 12.7 },
      });
      const claimedOrder = previewOrder({
        ...orderInput,
        status: 'preview_generating',
        claimToken: 'claim-token',
      }) as unknown as CncOrder;
      const job = buildWorkerJob(claimedOrder, { bucket: 'test-private', issuedAt: new Date('2026-09-07T00:00:00Z') });
      expect(job.config.options.includeKicker).toBe(includeKicker);
      expect(job.layoutRequest.manufacturing.include_kicker).toBe(includeKicker);
      expect(job.layoutRequest.manufacturing.kicker).toEqual(includeKicker ? { mat_clearance_mm: 50 } : undefined);
      expect(job.layoutRequest.board.set_ids).toEqual([1, 20]);
    },
  );

  it('rejects an OG 7x10 kicker before writing an order', async () => {
    await expect(
      cncPackMutations.createCncPreview(
        undefined,
        {
          config: config({ layoutId: 1, sizeId: 14, setIds: '1,20', options: { includeKicker: true }, artwork: [] }),
        },
        authCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });
    expect(createPreviewOrderMock).not.toHaveBeenCalled();
  });

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
  const orderUrl = 'https://www.boardsesh.com/build-plans/orders/BS-CNC-ABC234';

  it('requires authentication', async () => {
    await expect(cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, anonCtx())).rejects.toThrow(
      /Authentication required/,
    );
    expect(getOrderByIdMock).not.toHaveBeenCalled();
  });

  it('refuses finalisation while the PostHog flag is off', async () => {
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs=false');
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } });
    expect(getOrderByIdMock).not.toHaveBeenCalled();
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 'sk_test_fake', 'sk_live_fake'])(
    'queues a free personal pack with Stripe key %j',
    async (stripeKey) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STRIPE_SECRET_KEY', stripeKey);
      await expect(
        cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
      ).resolves.toEqual({ orderId: '7', licenceId: 'BS-CNC-ABC234', checkoutUrl: orderUrl });
      expect(transitionOrderMock).toHaveBeenCalledExactlyOnceWith(
        7,
        'finaliseFree',
        expect.objectContaining({
          tier: 'personal',
          licenseeName: 'Marco de Jongh',
          licenseeEmail: 'buyer@example.com',
          licenceAcceptedAt: expect.any(Date),
          amountCents: 0,
          currency: 'AUD',
          queuedAt: expect.any(Date),
          attempts: 0,
          claimToken: null,
        }),
      );
      expect(transitionOrderMock.mock.calls[0][2]).not.toHaveProperty('paidAt');
      expect(transitionOrderMock.mock.calls[0][2]).not.toHaveProperty('stripeCheckoutSessionId');
      expect(createPreviewOrderMock).not.toHaveBeenCalled();
      expect(createCheckoutSessionMock).not.toHaveBeenCalled();
      expect(attachCheckoutSessionMock).not.toHaveBeenCalled();
      expect(getAccountEmailMock).not.toHaveBeenCalled();
    },
  );

  it('allows a flag-enabled account without any Stripe configuration', async () => {
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs');
    vi.stubEnv('STRIPE_SECRET_KEY', undefined);
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).resolves.toMatchObject({ checkoutUrl: orderUrl });
  });

  it('refuses somebody else’s order the same way it refuses one that does not exist', async () => {
    for (const order of [previewOrder({ userId: 'someone-else' }), null]) {
      getOrderByIdMock.mockResolvedValue(order);
      await expect(
        cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
      ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    }
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it.each([
    'preview_queued',
    'preview_generating',
    'preview_failed',
    'pending_payment',
    'queued',
    'generating',
    'ready',
    'failed',
    'cancelled',
    'refunded',
  ])('refuses a %s order; only an approved preview can be finalised', async (status) => {
    getOrderByIdMock.mockResolvedValue(previewOrder({ status }));
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_ORDER_NOT_FINALISABLE', status } });
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('refuses when another tab already finalised the order', async () => {
    transitionOrderMock.mockResolvedValue(null);
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_ORDER_NOT_FINALISABLE' } });
  });

  it('requires licence acceptance even though generation is free', async () => {
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput({ acceptLicence: false }) }, authCtx()),
    ).rejects.toThrow(/accept the manufacturing licence/);
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Northside Climbing'])(
    'refuses commercial generation with site %j before looking up or moving an order',
    async (customerSiteName) => {
      await expect(
        cncPackMutations.finaliseCncOrder(
          undefined,
          {
            input: finaliseInput({ tier: 'commercial_single', customerSiteName }),
          },
          authCtx(),
        ),
      ).rejects.toThrow(/non-commercial use only.*partnerships@boardsesh.com/);
      expect(getOrderByIdMock).not.toHaveBeenCalled();
      expect(transitionOrderMock).not.toHaveBeenCalled();
      expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    },
  );

  it('treats an empty site name on a personal licence as no site name', async () => {
    await cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput({ customerSiteName: '  ' }) }, authCtx());
    expect(transitionOrderMock).toHaveBeenCalledWith(
      7,
      'finaliseFree',
      expect.objectContaining({ customerSiteName: null }),
    );
  });

  it('refuses a personal licence that names a customer site', async () => {
    await expect(
      cncPackMutations.finaliseCncOrder(
        undefined,
        {
          input: finaliseInput({ customerSiteName: 'Northside Climbing' }),
        },
        authCtx(),
      ),
    ).rejects.toThrow(/partnerships@boardsesh.com/);
  });

  it('refuses a wall the catalogue no longer offers', async () => {
    getOrderByIdMock.mockResolvedValue(previewOrder({ sizeId: 999 }));
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_INVALID_CONFIG' } });
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it.each([0, 1])('keeps artwork traceable without making attachment count %s a gate', async (attachedCount) => {
    transitionOrderMock.mockResolvedValue(
      previewOrder({ status: 'queued', artwork: [{ assetId: 'asset-1', assetKey: 'k', mime: 'm' }] }),
    );
    attachAssetsToOrderMock.mockResolvedValue(attachedCount);
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).resolves.toMatchObject({ checkoutUrl: orderUrl });
    expect(attachAssetsToOrderMock).toHaveBeenCalledWith(7, 'user-1', ['asset-1']);
  });

  it('still returns the order page when artwork cleanup stamping fails', async () => {
    transitionOrderMock.mockResolvedValue(previewOrder({ status: 'queued', artwork: [{ assetId: 'asset-1' }] }));
    attachAssetsToOrderMock.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
      cncPackMutations.finaliseCncOrder(undefined, { input: finaliseInput() }, authCtx()),
    ).resolves.toMatchObject({ checkoutUrl: orderUrl });
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
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs=false');
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
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs=false');
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
