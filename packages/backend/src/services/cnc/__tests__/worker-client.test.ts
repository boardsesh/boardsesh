import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../utils/logger';
import { findCatalogEntry, validateCatalogOptions, type CncCatalogEntry } from '../catalog';
import {
  clearCncWorkerCache,
  CncWorkerUnavailableError,
  CncWorkerValidationError,
  fetchLayout,
  isWorkerConfigured,
  toArtworkItems,
  toLayoutRequest,
  validateArtwork,
  type CncWorkerLayoutRequest,
} from '../worker-client';

const loggerMock = vi.mocked(logger);

const WORKER_URL = 'http://cnc-worker.railway.internal:8080';
const WORKER_SECRET = 'test-worker-secret';

/** The 10x12 wall — the only catalogue size with kicker sets, so it exercises both branches. */
function entry10x12(): CncCatalogEntry {
  const found = findCatalogEntry({ boardName: 'kilter', layoutId: 8, sizeId: 25 });
  if (!found) throw new Error('the 10x12 catalogue entry vanished');
  return found;
}

/** Catalogue defaults, normalised the same way a resolver would normalise them. */
function defaultOptions(entry: CncCatalogEntry) {
  const result = validateCatalogOptions(entry, {});
  if (!result.ok) throw new Error(`catalogue defaults are not valid: ${JSON.stringify(result.errors)}`);
  return result.options;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

/**
 * Stub `fetch` with a handler typed as the client actually calls it, so
 * `fetchMock.mock.calls[n]` is a `[url, init]` tuple rather than `[]`.
 */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The JSON body a recorded call sent, parsed. */
function sentBody(init: RequestInit): unknown {
  return JSON.parse(init.body as string);
}

const LAYOUT_BODY = { schema_version: 1, units: 'mm', panels: [{ index: 0 }] };

let originalUrl: string | undefined;
let originalSecret: string | undefined;

beforeEach(() => {
  clearCncWorkerCache();
  originalUrl = process.env.CNC_WORKER_URL;
  originalSecret = process.env.CNC_WORKER_SECRET;
  process.env.CNC_WORKER_URL = WORKER_URL;
  process.env.CNC_WORKER_SECRET = WORKER_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
  if (originalUrl === undefined) delete process.env.CNC_WORKER_URL;
  else process.env.CNC_WORKER_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.CNC_WORKER_SECRET;
  else process.env.CNC_WORKER_SECRET = originalSecret;
});

describe('isWorkerConfigured', () => {
  it('is false unless both the URL and the secret are set', () => {
    expect(isWorkerConfigured()).toBe(true);
    delete process.env.CNC_WORKER_SECRET;
    expect(isWorkerConfigured()).toBe(false);
  });

  it('refuses to call an unconfigured generator instead of hitting a bad URL', async () => {
    delete process.env.CNC_WORKER_URL;
    const fetchMock = stubFetch(async () => jsonResponse({}));

    await expect(fetchLayout(toLayoutRequestForDefaults())).rejects.toBeInstanceOf(CncWorkerUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function toLayoutRequestForDefaults(): CncWorkerLayoutRequest {
  const entry = entry10x12();
  return toLayoutRequest({ entry, options: defaultOptions(entry), setIds: [26, 27, 28, 29] });
}

describe('toLayoutRequest', () => {
  it('maps catalogue option keys onto the generator contract', () => {
    const entry = entry10x12();
    const request = toLayoutRequest({ entry, options: defaultOptions(entry), setIds: [26, 27, 28, 29] });

    expect(request).toEqual({
      board: { board_name: 'kilter', layout_id: 8, size_id: 25, set_ids: [26, 27, 28, 29] },
      manufacturing: {
        sheet: { length_mm: 2440, width_mm: 1220, thickness_mm: 18 },
        grid_pitch_mm: 100,
        tnut_hole_diameter_mm: 12.5,
        led_hole_diameter_mm: 12.5,
        stud_clearance_offset_mm: 60,
        kicker: { mat_clearance_mm: 50 },
      },
    });
  });

  it('leaves the kicker block out when no kicker set was chosen', () => {
    const entry = entry10x12();
    const request = toLayoutRequest({ entry, options: defaultOptions(entry), setIds: [26, 27] });

    expect(request.manufacturing.kicker).toBeUndefined();
    expect(request.board.set_ids).toEqual([26, 27]);
  });

  it('splits sheetStock into length and width, and follows the chosen thickness', () => {
    const entry = entry10x12();
    const options = validateCatalogOptions(entry, { sheetStock: '3600x1220', panelThicknessMm: 21 });
    if (!options.ok) throw new Error('expected valid options');

    const request = toLayoutRequest({ entry, options: options.options, setIds: [26, 27] });
    expect(request.manufacturing.sheet).toEqual({ length_mm: 3600, width_mm: 1220, thickness_mm: 21 });
  });

  it('resolves an LED-kit size alias onto the canonical size', () => {
    // 26 is the 10x12 Mainline kit; it must buy the same layout as 25.
    const aliased = findCatalogEntry({ boardName: 'kilter', layoutId: 8, sizeId: 26 });
    if (!aliased) throw new Error('alias 26 did not resolve');

    const request = toLayoutRequest({ entry: aliased, options: defaultOptions(aliased), setIds: [26, 27] });
    expect(request.board.size_id).toBe(25);
  });
});

describe('toArtworkItems', () => {
  it('derives the kind from which of text/assetId is set and flattens the placement', () => {
    const items = toArtworkItems([
      {
        text: 'Home wall',
        mode: 'engrave',
        placement: { panelIndex: 1, xMm: 600, yMm: 400, widthMm: 300, rotationDeg: -15 },
      },
      {
        assetId: 'asset-1',
        mode: 'cut_through',
        placement: { panelIndex: 0, xMm: 100, yMm: 200, widthMm: 80, rotationDeg: 0 },
      },
    ]);

    expect(items).toEqual([
      {
        kind: 'text',
        text: 'Home wall',
        asset_ref: null,
        mode: 'engrave',
        placement: { panel_index: 1, x_mm: 600, y_mm: 400, width_mm: 300, rotation_deg: -15 },
      },
      {
        kind: 'svg',
        text: null,
        asset_ref: 'asset-1',
        mode: 'cut_through',
        placement: { panel_index: 0, x_mm: 100, y_mm: 200, width_mm: 80, rotation_deg: 0 },
      },
    ]);
  });
});

describe('fetchLayout', () => {
  it('sends the bearer secret and the request body to /layout', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(LAYOUT_BODY));

    const request = toLayoutRequestForDefaults();
    await expect(fetchLayout(request)).resolves.toEqual(LAYOUT_BODY);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${WORKER_URL}/layout`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${WORKER_SECRET}`);
    expect(sentBody(init)).toEqual(request);
  });

  it('serves a repeat of the same request from cache', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(LAYOUT_BODY));

    const request = toLayoutRequestForDefaults();
    await fetchLayout(request);
    await fetchLayout(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let the cheap variant answer for the include=holes one', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(LAYOUT_BODY));

    const request = toLayoutRequestForDefaults();
    await fetchLayout(request);
    await fetchLayout(request, { includeHoles: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${WORKER_URL}/layout?include=holes`);
  });

  it('caches on the request, not on the order its keys were built in', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(LAYOUT_BODY));

    const request = toLayoutRequestForDefaults();
    // Same values, keys inserted in the opposite order.
    const reordered = {
      manufacturing: { ...request.manufacturing },
      board: { ...request.board },
    } as CncWorkerLayoutRequest;

    await fetchLayout(request);
    await fetchLayout(reordered);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns a timeout into unavailable rather than hanging', async () => {
    vi.useFakeTimers();
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );

    const pending = fetchLayout(toLayoutRequestForDefaults());
    const assertion = expect(pending).rejects.toBeInstanceOf(CncWorkerUnavailableError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('turns a 422 into a validation error carrying the generator error code', async () => {
    stubFetch(async () =>
      jsonResponse(
        { code: 'SEAM_TOO_CLOSE_TO_HOLE', message: 'A seam falls 12 mm from a T-nut', details: { row: 12 } },
        422,
      ),
    );

    await expect(fetchLayout(toLayoutRequestForDefaults())).rejects.toMatchObject({
      name: 'CncWorkerValidationError',
      code: 'SEAM_TOO_CLOSE_TO_HOLE',
      message: 'A seam falls 12 mm from a T-nut',
      details: { row: 12 },
    });
  });

  it('does not cache a rejected configuration', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ code: 'PANEL_EXCEEDS_SHEET', message: 'too wide' }, 422));

    const request = toLayoutRequestForDefaults();
    await expect(fetchLayout(request)).rejects.toBeInstanceOf(CncWorkerValidationError);
    await expect(fetchLayout(request)).rejects.toBeInstanceOf(CncWorkerValidationError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logs a rejected credential at error and reports unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: 'Not authenticated' }, 401)),
    );

    await expect(fetchLayout(toLayoutRequestForDefaults())).rejects.toBeInstanceOf(CncWorkerUnavailableError);

    expect(loggerMock.error).toHaveBeenCalledWith(
      '[cnc-worker] rejected our credentials; check CNC_WORKER_SECRET',
      expect.objectContaining({ status: 401 }),
    );
  });

  it('reports unavailable on a 500 without escalating the log to error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 500)),
    );

    await expect(fetchLayout(toLayoutRequestForDefaults())).rejects.toBeInstanceOf(CncWorkerUnavailableError);

    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '[cnc-worker] unexpected status',
      expect.objectContaining({ status: 500 }),
    );
  });

  it('reports unavailable when the connection fails outright', async () => {
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(fetchLayout(toLayoutRequestForDefaults())).rejects.toBeInstanceOf(CncWorkerUnavailableError);
  });
});

describe('validateArtwork', () => {
  it('posts the layout request alongside the artwork and caches the verdict', async () => {
    const verdict = { ok: false, collisions: [{ artwork_index: 0, kind: 'keepout' }] };
    const fetchMock = stubFetch(async () => jsonResponse(verdict));

    const request = toLayoutRequestForDefaults();
    const artwork = toArtworkItems([
      { text: 'Send it', mode: 'engrave', placement: { panelIndex: 0, xMm: 1, yMm: 2, widthMm: 100, rotationDeg: 0 } },
    ]);

    await expect(validateArtwork(request, artwork)).resolves.toEqual(verdict);
    await validateArtwork(request, artwork);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${WORKER_URL}/artwork/validate`);
    expect(sentBody(init)).toEqual({ layout_request: request, artwork });
  });
});
