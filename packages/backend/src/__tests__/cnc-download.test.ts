import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The authenticated build-pack download, against the real database.
 *
 * The interesting cases are all authorisation and status: who may fetch a
 * licensed file, and when. Those are decided against the order row, so the row
 * is real. Object storage is mocked (there is no bucket in CI) and so is
 * PostHog.
 */

const { getFromS3Mock, getS3ObjectMetadataMock, isS3ConfiguredMock } = vi.hoisted(() => ({
  getFromS3Mock: vi.fn(),
  getS3ObjectMetadataMock: vi.fn(),
  isS3ConfiguredMock: vi.fn(() => true),
}));

vi.mock('../storage/s3', () => ({
  getFromS3: getFromS3Mock,
  getS3ObjectMetadata: getS3ObjectMetadataMock,
  isS3Configured: isS3ConfiguredMock,
}));

const { validateTokenMock } = vi.hoisted(() => ({ validateTokenMock: vi.fn() }));
vi.mock('../middleware/auth', () => ({ validateToken: validateTokenMock }));

const { captureBackendEventMock } = vi.hoisted(() => ({ captureBackendEventMock: vi.fn(() => true) }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: captureBackendEventMock }));

import { eq } from 'drizzle-orm';
import { cncOrders, type CncOrderOptions } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { handleCncPackDownload } from '../handlers/cnc-download';
import { initCors } from '../handlers/cors';
import { createDownloadGrant } from '../services/cnc/download-grant';

const GRANT_SECRET = 'download-grant-secret-for-tests';

const DEFAULT_OPTIONS: CncOrderOptions = {
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

/** A writable stand-in for ServerResponse that keeps whatever was piped into it. */
class TestResponse extends Writable {
  statusCode = 0;
  headers: Record<string, string | string[]> = {};
  /**
   * The error the handler destroyed the response with, if it did.
   *
   * A real `ServerResponse.destroy(err)` resets the socket and emits nothing on
   * itself; a `Writable` re-emits the error, so the listener both keeps that
   * from crashing the run and records what a mid-stream failure did.
   */
  destroyedWith: Error | null = null;
  private readonly chunks: Buffer[] = [];

  constructor() {
    super();
    this.on('error', (error: Error) => {
      this.destroyedWith = error;
    });
  }

  setHeader(name: string, value: string | string[]): void {
    this.headers[name] = value;
  }

  writeHead(statusCode: number, headers: Record<string, string | string[]> = {}): void {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
  }

  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  json(): unknown {
    return JSON.parse(this.body);
  }
}

function makeRequest(headers: Record<string, string> = {}, method = 'GET') {
  return Object.assign(Readable.from([]), { method, headers });
}

type DownloadOptions = { bearer?: string; grant?: string; method?: string; origin?: string };

async function download(licenceId: string, options: DownloadOptions = {}): Promise<TestResponse> {
  const res = new TestResponse();
  const url = new URL(
    `/api/cnc/packs/${encodeURIComponent(licenceId)}/download${options.grant ? `?token=${encodeURIComponent(options.grant)}` : ''}`,
    'http://backend.test',
  );
  const headers: Record<string, string> = { host: 'backend.test' };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.origin) headers.origin = options.origin;
  const req = makeRequest(headers, options.method ?? 'GET');

  // `close`, and hand-rolled rather than `events.once`: a stream that fails
  // mid-body destroys the response, so waiting on `finish` would hang, and
  // `events.once` would reject on the `error` that a destroy emits — turning
  // the one path worth testing into an unhandled rejection instead of an
  // assertion.
  const settled = new Promise<void>((resolve) => {
    res.once('close', () => resolve());
  });
  await handleCncPackDownload(
    req as unknown as import('http').IncomingMessage,
    res as unknown as import('http').ServerResponse,
    url,
  );
  await settled;
  return res;
}

let licenceCounter = 0;

/**
 * A distinct, WELL-FORMED licence id. The alphabet matters: the route validates
 * the shape before it looks anything up, so an id containing a 0/1/I/O/U would
 * 404 for the wrong reason.
 */
const LICENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
function nextLicenceId(): string {
  licenceCounter += 1;
  let remaining = licenceCounter;
  let suffix = '';
  for (let position = 0; position < 6; position += 1) {
    suffix = LICENCE_ALPHABET[remaining % LICENCE_ALPHABET.length] + suffix;
    remaining = Math.floor(remaining / LICENCE_ALPHABET.length);
  }
  return `BS-CNC-${suffix}`;
}

async function insertOrder(overrides: Partial<typeof cncOrders.$inferInsert> = {}) {
  // The licence id is needed twice — the row and its object key — and the key
  // has to be the shape the route will accept, so it is minted first.
  const licenceId = overrides.licenceId ?? nextLicenceId();
  const [order] = await db
    .insert(cncOrders)
    .values({
      licenceId,
      userId: 'user-123',
      tier: 'personal',
      status: 'ready',
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 25,
      setIds: '26,27,28,29',
      options: DEFAULT_OPTIONS,
      catalogVersion: '2026-09-06.1',
      licenseeName: 'Marco',
      licenseeEmail: 'marco@example.com',
      currency: 'AUD',
      amountCents: 14900,
      zipKey: `cnc-packs/user-123/${licenceId}.zip`,
      zipSizeBytes: ZIP_BYTES,
      generatedAt: new Date(),
      ...overrides,
    })
    .returning();
  return order;
}

async function readOrder(orderId: number) {
  const [order] = await db.select().from(cncOrders).where(eq(cncOrders.id, orderId)).limit(1);
  return order;
}

/** The bytes the stubbed bucket hands back, and the size the order row records. */
const ZIP_CONTENTS = 'PK-zip-🗜';
const ZIP_BYTES = Buffer.byteLength(ZIP_CONTENTS);

function stubZipBody(contents = ZIP_CONTENTS): void {
  getFromS3Mock.mockImplementation(async () => ({
    stream: Readable.from([Buffer.from(contents)]),
    contentType: 'application/zip',
    contentLength: Buffer.byteLength(contents),
  }));
  getS3ObjectMetadataMock.mockImplementation(async () => ({
    contentType: 'application/zip',
    contentLength: Buffer.byteLength(contents),
  }));
}

beforeEach(async () => {
  initCors('http://localhost:3000');
  process.env.CNC_DOWNLOAD_TOKEN_SECRET = GRANT_SECRET;
  await db.delete(cncOrders);
  vi.clearAllMocks();
  isS3ConfiguredMock.mockReturnValue(true);
  validateTokenMock.mockResolvedValue({ userId: 'user-123' });
  stubZipBody();
});

afterEach(() => {
  delete process.env.CNC_DOWNLOAD_TOKEN_SECRET;
});

describe('GET /api/cnc/packs/:licenceId/download', () => {
  it('streams the pack and counts the download', async () => {
    const order = await insertOrder();

    const res = await download(order.licenceId, { bearer: 'session-token' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(ZIP_CONTENTS);
    expect(res.headers['Content-Type']).toBe('application/zip');
    expect(res.headers['Content-Disposition']).toBe(
      `attachment; filename="boardsesh-build-plans-${order.licenceId}.zip"`,
    );
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Length']).toBe(String(ZIP_BYTES));
    expect(getFromS3Mock).toHaveBeenCalledWith('private', `cnc-packs/user-123/${order.licenceId}.zip`);

    const counted = await readOrder(order.id);
    expect(counted.downloadCount).toBe(1);
    expect(counted.lastDownloadedAt).not.toBeNull();
    expect(captureBackendEventMock).toHaveBeenCalledWith(
      'Build Plans Pack Downloaded',
      expect.objectContaining({ distinctId: 'user-123' }),
    );
  });

  it('404s somebody else’s licence exactly as it 404s one that does not exist', async () => {
    const order = await insertOrder();
    validateTokenMock.mockResolvedValue({ userId: 'user-999' });

    const theirs = await download(order.licenceId, { bearer: 'session-token' });
    const nothing = await download('BS-CNC-ZZZZZZ', { bearer: 'session-token' });

    expect(theirs.statusCode).toBe(404);
    expect(nothing.statusCode).toBe(404);
    expect(theirs.body).toBe(nothing.body);
  });

  it('409s a pack that is not generated yet', async () => {
    const order = await insertOrder({ status: 'generating', zipKey: null, generatedAt: null });

    const res = await download(order.licenceId, { bearer: 'session-token' });

    expect(res.statusCode).toBe(409);
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });

  it('403s a refunded order', async () => {
    const order = await insertOrder({ status: 'refunded', refundedAt: new Date() });

    const res = await download(order.licenceId, { bearer: 'session-token' });

    expect(res.statusCode).toBe(403);
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });

  it('403s a ready order that also carries a refund, failing closed', async () => {
    const order = await insertOrder({ status: 'ready', refundedAt: new Date() });

    expect((await download(order.licenceId, { bearer: 'session-token' })).statusCode).toBe(403);
  });

  it('accepts a fresh grant token with no Authorization header', async () => {
    const order = await insertOrder();
    const { token } = createDownloadGrant({ orderId: order.id, userId: 'user-123' }, new Date());

    const res = await download(order.licenceId, { grant: token });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(ZIP_CONTENTS);
    expect(validateTokenMock).not.toHaveBeenCalled();
  });

  it('401s an expired grant token', async () => {
    const order = await insertOrder();
    const { token } = createDownloadGrant({ orderId: order.id, userId: 'user-123' }, new Date(Date.now() - 3_600_000));

    const res = await download(order.licenceId, { grant: token });

    expect(res.statusCode).toBe(401);
  });

  it('401s a grant token signed with a different secret', async () => {
    const order = await insertOrder();
    const { token } = createDownloadGrant({ orderId: order.id, userId: 'user-123' }, new Date());
    process.env.CNC_DOWNLOAD_TOKEN_SECRET = 'rotated-secret';

    expect((await download(order.licenceId, { grant: token })).statusCode).toBe(401);
  });

  it('404s a grant token minted for another user', async () => {
    const order = await insertOrder();
    const { token } = createDownloadGrant({ orderId: order.id, userId: 'user-999' }, new Date());

    const res = await download(order.licenceId, { grant: token });

    expect(res.statusCode).toBe(404);
  });

  it('404s a grant token minted for a different order', async () => {
    const order = await insertOrder();
    const { token } = createDownloadGrant({ orderId: order.id + 4242, userId: 'user-123' }, new Date());

    expect((await download(order.licenceId, { grant: token })).statusCode).toBe(404);
  });

  it('401s with no credentials at all', async () => {
    const order = await insertOrder();

    expect((await download(order.licenceId)).statusCode).toBe(401);
  });

  it('404s when the order says ready but the object is gone', async () => {
    const order = await insertOrder();
    getS3ObjectMetadataMock.mockResolvedValue(null);

    const res = await download(order.licenceId, { bearer: 'session-token' });

    expect(res.statusCode).toBe(404);
    expect(getFromS3Mock).not.toHaveBeenCalled();
    expect((await readOrder(order.id)).downloadCount).toBe(0);
  });

  it('500s when the stored object is not the size the order was completed with', async () => {
    const order = await insertOrder();
    getS3ObjectMetadataMock.mockResolvedValue({ contentType: 'application/zip', contentLength: ZIP_BYTES + 4096 });

    const res = await download(order.licenceId, { bearer: 'session-token' });

    // Caught by the HEAD, so nothing was streamed and the buyer never got a
    // file whose fingerprint manifest no longer describes it.
    expect(res.statusCode).toBe(500);
    expect(getFromS3Mock).not.toHaveBeenCalled();
    expect((await readOrder(order.id)).downloadCount).toBe(0);
  });

  it('409s a ready order whose zip key is not a pack key, without reading it', async () => {
    const order = await insertOrder({ zipKey: 'user-exports/user-123/everything.zip' });

    const res = await download(order.licenceId, { bearer: 'session-token' });

    expect(res.statusCode).toBe(409);
    expect(getS3ObjectMetadataMock).not.toHaveBeenCalled();
    expect(getFromS3Mock).not.toHaveBeenCalled();
    expect((await readOrder(order.id)).downloadCount).toBe(0);
  });

  it('409s a zip key that escapes the pack prefix with traversal', async () => {
    const order = await insertOrder({ zipKey: 'cnc-packs/../user-exports/BS-CNC-ABCDEF.zip' });

    expect((await download(order.licenceId, { bearer: 'session-token' })).statusCode).toBe(409);
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });

  it('destroys the response when the object stream fails partway through', async () => {
    const order = await insertOrder();
    const failure = new Error('connection reset by the object store');
    getFromS3Mock.mockImplementation(async () => ({
      stream: new Readable({
        read() {
          this.push(Buffer.from('PK'));
          this.destroy(failure);
        },
      }),
      contentType: 'application/zip',
      contentLength: ZIP_BYTES,
    }));

    const res = await download(order.licenceId, { bearer: 'session-token' });

    // The 200 was already on the wire, so the only honest signal left is a
    // broken transfer — never a short body that reads as a complete zip.
    expect(res.statusCode).toBe(200);
    expect(res.destroyedWith).toBe(failure);
    expect(res.writableFinished).toBe(false);
  });

  it('503s without counting a download when object storage is not configured', async () => {
    const order = await insertOrder();
    isS3ConfiguredMock.mockReturnValue(false);

    const res = await download(order.licenceId, { bearer: 'session-token' });

    expect(res.statusCode).toBe(503);
    expect(getS3ObjectMetadataMock).not.toHaveBeenCalled();
    expect(getFromS3Mock).not.toHaveBeenCalled();
    // An operator outage must not spend one of the buyer's downloads.
    expect((await readOrder(order.id)).downloadCount).toBe(0);
    expect(captureBackendEventMock).not.toHaveBeenCalled();
  });

  it('answers an OPTIONS preflight with the CORS headers and no order lookup', async () => {
    const order = await insertOrder();

    const res = await download(order.licenceId, { method: 'OPTIONS', origin: 'http://localhost:3000' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    expect(res.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(res.headers['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('GET');
    // A preflight carries no credentials, so it must never reach auth.
    expect(validateTokenMock).not.toHaveBeenCalled();
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });

  it('does not echo an origin that is not allow-listed', async () => {
    const order = await insertOrder();

    const res = await download(order.licenceId, { method: 'OPTIONS', origin: 'https://evil.example' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
