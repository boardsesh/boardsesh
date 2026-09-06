import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

vi.mock('../../../../db/client', () => ({ db: {}, dbRead: {} }));

// See the note in queries.test.ts: the real limiter's tier-1 bucket does not
// reset between tests, so leaving it in would make test order significant.
vi.mock('../../shared/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/helpers')>()),
  applyRateLimit: vi.fn(async () => {}),
}));

const { validateArtworkMock } = vi.hoisted(() => ({ validateArtworkMock: vi.fn() }));

vi.mock('../../../../services/cnc/worker-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/cnc/worker-client')>()),
  validateArtwork: validateArtworkMock,
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

beforeEach(() => {
  vi.clearAllMocks();
});

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
        asset_ref: null,
        mode: 'engrave',
        placement: { panel_index: 0, x_mm: 600, y_mm: 400, width_mm: 300, rotation_deg: 0 },
      },
    ]);
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
