import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The authenticated build-pack download, against the real database.
 *
 * The interesting cases are all authorisation and status: who may fetch a
 * licensed file, and when. Those are decided against the order row, so the row
 * is real. Object storage is mocked (there is no bucket in CI) and so is
 * PostHog.
 */

const { getFromS3Mock, isS3ConfiguredMock } = vi.hoisted(() => ({
  getFromS3Mock: vi.fn(),
  isS3ConfiguredMock: vi.fn(() => true),
}));

vi.mock('../storage/s3', () => ({
  getFromS3: getFromS3Mock,
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
  private readonly chunks: Buffer[] = [];

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

function makeRequest(headers: Record<string, string> = {}) {
  return Object.assign(Readable.from([]), { method: 'GET', headers });
}

async function download(licenceId: string, options: { bearer?: string; grant?: string } = {}): Promise<TestResponse> {
  const res = new TestResponse();
  const url = new URL(
    `/api/cnc/packs/${encodeURIComponent(licenceId)}/download${options.grant ? `?token=${encodeURIComponent(options.grant)}` : ''}`,
    'http://backend.test',
  );
  const req = makeRequest(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {});

  const finished = once(res, 'finish');
  await handleCncPackDownload(
    req as unknown as import('http').IncomingMessage,
    res as unknown as import('http').ServerResponse,
    url,
  );
  await finished;
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
  const [order] = await db
    .insert(cncOrders)
    .values({
      licenceId: nextLicenceId(),
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
      zipKey: 'cnc-packs/user-123/pack.zip',
      zipSizeBytes: 9,
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

function stubZipBody(contents = 'PK-zip-🗜'): void {
  getFromS3Mock.mockImplementation(async () => ({
    stream: Readable.from([Buffer.from(contents)]),
    contentType: 'application/zip',
    contentLength: Buffer.byteLength(contents),
  }));
}

beforeEach(async () => {
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
    expect(res.body).toBe('PK-zip-🗜');
    expect(res.headers['Content-Type']).toBe('application/zip');
    expect(res.headers['Content-Disposition']).toBe(
      `attachment; filename="boardsesh-build-plans-${order.licenceId}.zip"`,
    );
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Length']).toBe(String(Buffer.byteLength('PK-zip-🗜')));
    expect(getFromS3Mock).toHaveBeenCalledWith('private', 'cnc-packs/user-123/pack.zip');

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
    expect(res.body).toBe('PK-zip-🗜');
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
    getFromS3Mock.mockResolvedValue(null);

    const res = await download(order.licenceId, { bearer: 'session-token' });

    expect(res.statusCode).toBe(404);
    expect((await readOrder(order.id)).downloadCount).toBe(0);
  });
});
