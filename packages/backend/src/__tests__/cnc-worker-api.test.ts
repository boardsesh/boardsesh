import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The pack generator's job API, against the real database.
 *
 * DB-backed rather than mocked because the properties worth testing here are
 * database properties: a claim that hands the same row to two workers, a
 * completion that lands on a lease its worker no longer holds, an attempt
 * counter that decides whether a failure is terminal. A mocked drizzle chain
 * would assert the code we wrote, not the behaviour the row has.
 *
 * Object storage and email are mocked — the first because there is no bucket in
 * CI, the second because a send is best-effort and its absence must never
 * change a status.
 */

const { getS3ObjectMetadataMock, getFromS3Mock, isS3ConfiguredMock, getBucketNameMock } = vi.hoisted(() => ({
  getS3ObjectMetadataMock: vi.fn(),
  getFromS3Mock: vi.fn(),
  isS3ConfiguredMock: vi.fn(() => true),
  getBucketNameMock: vi.fn(() => 'boardsesh-private'),
}));

vi.mock('../storage/s3', () => ({
  getS3ObjectMetadata: getS3ObjectMetadataMock,
  getFromS3: getFromS3Mock,
  isS3Configured: isS3ConfiguredMock,
  getBucketName: getBucketNameMock,
}));

const { sendPackReadyMock, sendPackFailedMock } = vi.hoisted(() => ({
  sendPackReadyMock: vi.fn(async () => {}),
  sendPackFailedMock: vi.fn(async () => {}),
}));

vi.mock('../email/cnc-emails', () => ({
  sendCncPackReadyEmail: sendPackReadyMock,
  sendCncPackFailedAdminEmail: sendPackFailedMock,
}));

import { eq } from 'drizzle-orm';
import { cncArtAssets, cncOrders, users, type CncOrderOptions } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { handleCncWorkerApi } from '../handlers/cnc-worker';
import { cncArtAssetKey, createArtAsset } from '../services/cnc/art-assets';

const WORKER_SECRET = 'worker-secret-for-tests';

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

/**
 * A placement with all five numbers. `buildWorkerJob` refuses an artwork item
 * without one, so any fixture that expects to be claimed needs a real
 * placement rather than the panel index alone.
 */
const COMPLETE_PLACEMENT = { panelIndex: 0, xMm: 600, yMm: 900, widthMm: 200, rotationDeg: 0 };

type TestResponse = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  json: () => unknown;
  setHeader: (name: string, value: string | string[]) => void;
  writeHead: (statusCode: number, headers?: Record<string, string | string[]>) => void;
  end: (body?: string) => void;
};

function makeRequest(options: { method: string; headers?: Record<string, string>; body?: unknown }) {
  const serialised = options.body === undefined ? undefined : JSON.stringify(options.body);
  // Buffers, not strings: `readJsonBody` concatenates the chunks, and
  // `Buffer.concat` rejects a string outright.
  const request = Readable.from(serialised ? [Buffer.from(serialised)] : []);
  return Object.assign(request, {
    method: options.method,
    headers: options.headers ?? {},
  });
}

function makeResponse(): TestResponse {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    json() {
      return JSON.parse(this.body);
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(body = '') {
      this.body += body;
    },
  };
}

async function callWorker(
  path: string,
  options: { method?: string; body?: unknown; secret?: string | null } = {},
): Promise<TestResponse> {
  const { method = 'POST', body, secret = WORKER_SECRET } = options;
  const res = makeResponse();
  const req = makeRequest({
    method,
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
    body,
  });
  await handleCncWorkerApi(
    req as unknown as import('http').IncomingMessage,
    res as unknown as import('http').ServerResponse,
    new URL(path, 'http://backend.test'),
  );
  return res;
}

/** A writable stand-in for ServerResponse, for the one route that pipes a body. */
class StreamingTestResponse extends Writable {
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
}

/** GET a worker route and wait for the piped body to finish arriving. */
async function callWorkerStreaming(path: string): Promise<StreamingTestResponse> {
  const res = new StreamingTestResponse();
  const req = makeRequest({ method: 'GET', headers: { authorization: `Bearer ${WORKER_SECRET}` } });
  const finished = once(res, 'finish');
  await handleCncWorkerApi(
    req as unknown as import('http').IncomingMessage,
    res as unknown as import('http').ServerResponse,
    new URL(path, 'http://backend.test'),
  );
  await finished;
  return res;
}

let licenceCounter = 0;

/**
 * A distinct, WELL-FORMED licence id per row. The alphabet matters: the
 * download route validates the shape before it looks anything up, so a fixture
 * id containing a 0/1/I/O/U would 404 for the wrong reason.
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

/** A paid, queued order sitting in the generation queue. */
async function insertQueuedOrder(overrides: Partial<typeof cncOrders.$inferInsert> = {}) {
  const [order] = await db
    .insert(cncOrders)
    .values({
      licenceId: nextLicenceId(),
      userId: 'user-123',
      tier: 'personal',
      status: 'queued',
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 25,
      setIds: '26,27,28,29',
      options: DEFAULT_OPTIONS,
      artwork: null,
      catalogVersion: '2026-09-06.1',
      licenseeName: 'Marco',
      licenseeEmail: 'marco@example.com',
      currency: 'AUD',
      amountCents: 14900,
      queuedAt: new Date(Date.now() - 60_000),
      paidAt: new Date(Date.now() - 60_000),
      ...overrides,
    })
    .returning();
  return order;
}

async function readOrder(orderId: number) {
  const [order] = await db.select().from(cncOrders).where(eq(cncOrders.id, orderId)).limit(1);
  return order;
}

/** Claim a job and return the payload the worker would receive. */
async function claimJob(workerId = 'worker-1') {
  const res = await callWorker('/api/cnc/worker/claim', { body: { workerId } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { job: Record<string, unknown> | null }).job;
}

beforeEach(async () => {
  process.env.CNC_WORKER_SECRET = WORKER_SECRET;
  await db.delete(cncArtAssets);
  await db.delete(cncOrders);
  await db
    .insert(users)
    .values({ id: 'user-123', email: 'user-123@cnc-worker-test.local', name: 'user-123' })
    .onConflictDoNothing();
  vi.clearAllMocks();
  isS3ConfiguredMock.mockReturnValue(true);
  getBucketNameMock.mockReturnValue('boardsesh-private');
});

afterEach(() => {
  delete process.env.CNC_WORKER_SECRET;
});

describe('worker authentication', () => {
  it('404s the whole API when CNC_WORKER_SECRET is unset', async () => {
    delete process.env.CNC_WORKER_SECRET;

    const res = await callWorker('/api/cnc/worker/claim', { body: { workerId: 'worker-1' }, secret: 'anything' });

    expect(res.statusCode).toBe(404);
  });

  it('401s a wrong secret', async () => {
    const res = await callWorker('/api/cnc/worker/claim', { body: { workerId: 'worker-1' }, secret: 'wrong-secret' });

    expect(res.statusCode).toBe(401);
  });

  it('401s a missing Authorization header', async () => {
    const res = await callWorker('/api/cnc/worker/claim', { body: { workerId: 'worker-1' }, secret: null });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/cnc/worker/claim', () => {
  it('hands out a queued order with the documented job shape', async () => {
    const order = await insertQueuedOrder();

    const job = await claimJob();

    expect(job).toMatchObject({
      orderId: order.id,
      licenceId: order.licenceId,
      generation: 1,
      attempt: 1,
      tier: 'personal',
      licensee: { name: 'Marco', email: 'marco@example.com', customerSiteName: null },
      config: {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 25,
        setIds: [26, 27, 28, 29],
        artwork: [],
      },
      catalogVersion: '2026-09-06.1',
      output: {
        engrave: { holdIds: false, angleTicks: false },
        dxfFlavour: 'R12_circles',
        paper: 'A3',
      },
      outputKey: `cnc-packs/user-123/${order.licenceId}.zip`,
      bucket: 'boardsesh-private',
    });
    expect(typeof job?.claimToken).toBe('string');
    expect(typeof job?.issuedAt).toBe('string');
    // The generator's own request model, snake_case, ready to hand to compute_layout.
    expect(job?.layoutRequest).toEqual({
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

    const claimed = await readOrder(order.id);
    expect(claimed.status).toBe('generating');
    expect(claimed.attempts).toBe(1);
    expect(claimed.workerId).toBe('worker-1');
  });

  it('gives the second claimer nothing when there is only one job', async () => {
    await insertQueuedOrder();

    expect(await claimJob('worker-1')).not.toBeNull();
    expect(await claimJob('worker-2')).toBeNull();
  });

  it('fails an order whose stored options cannot be turned into a job', async () => {
    // A sheet stock the generator's request shape cannot parse. Retrying would
    // rebuild the identical unbuildable payload, so this is terminal at once.
    const order = await insertQueuedOrder({ options: { ...DEFAULT_OPTIONS, sheetStock: 'not-a-sheet' } });

    expect(await claimJob()).toBeNull();

    const failed = await readOrder(order.id);
    expect(failed.status).toBe('failed');
    expect(failed.claimToken).toBeNull();
    expect(sendPackFailedMock).toHaveBeenCalledTimes(1);
  });

  it('fails an order with no licensee name to print on the pack', async () => {
    // The name is on every sheet. A pack that says "undefined" across the
    // title block is worse than no pack, and no retry fixes a null column.
    const order = await insertQueuedOrder({ licenseeName: null });

    expect(await claimJob()).toBeNull();

    const failed = await readOrder(order.id);
    expect(failed.status).toBe('failed');
    expect(failed.claimToken).toBeNull();
    expect(failed.lastError).toContain('licensee name');
    expect(sendPackFailedMock).toHaveBeenCalledTimes(1);
  });

  it('fails an order whose artwork placement is missing a coordinate', async () => {
    // A half-written placement used to reach the generator as an opaque
    // object: it would crash mid-job three times over, or route the item
    // somewhere nobody asked for.
    const order = await insertQueuedOrder({
      artwork: [{ assetId: 'asset-1', mode: 'engrave', placement: { panelIndex: 0, xMm: 600, yMm: 900 } }],
    });

    expect(await claimJob()).toBeNull();

    const failed = await readOrder(order.id);
    expect(failed.status).toBe('failed');
    expect(failed.claimToken).toBeNull();
    expect(failed.lastError).toContain('widthMm');
    expect(sendPackFailedMock).toHaveBeenCalledTimes(1);
  });

  it('carries a complete placement and the stored font through to the job', async () => {
    await insertQueuedOrder({
      artwork: [{ text: 'MARCO', font: 'liberation-sans', mode: 'engrave', placement: COMPLETE_PLACEMENT }],
    });

    const job = await claimJob();

    const config = job?.config as { artwork: unknown[] } | undefined;
    expect(config?.artwork).toEqual([
      {
        assetId: null,
        assetKey: null,
        mime: null,
        text: 'MARCO',
        font: 'liberation-sans',
        mode: 'engrave',
        placement: COMPLETE_PLACEMENT,
      },
    ]);
  });

  it('carries the asset key and mime checkout stored, not a live asset lookup', async () => {
    await insertQueuedOrder({
      artwork: [
        {
          assetId: 'asset-1',
          assetKey: 'cnc-art/user-123/0b3f5a1c-1111-4222-8333-444455556666.svg',
          mime: 'image/svg+xml',
          mode: 'cut_through',
          placement: COMPLETE_PLACEMENT,
        },
      ],
    });

    const job = await claimJob();

    // Read off the ORDER: `cnc_art_assets.user_id` cascades, so a buyer who
    // deleted their account would otherwise strand a regenerate with no key.
    const config = job?.config as { artwork: unknown[] } | undefined;
    expect(config?.artwork).toEqual([
      {
        assetId: 'asset-1',
        assetKey: 'cnc-art/user-123/0b3f5a1c-1111-4222-8333-444455556666.svg',
        mime: 'image/svg+xml',
        text: null,
        font: null,
        mode: 'cut_through',
        placement: COMPLETE_PLACEMENT,
      },
    ]);
  });

  it('503s when the private bucket is not configured', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    await insertQueuedOrder();

    const res = await callWorker('/api/cnc/worker/claim', { body: { workerId: 'worker-1' } });

    expect(res.statusCode).toBe(503);
  });
});

describe('POST /api/cnc/worker/jobs/:orderId/heartbeat', () => {
  it('extends a live lease', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/heartbeat`, {
      body: { claimToken: job?.claimToken },
    });

    expect(res.statusCode).toBe(200);
  });

  it('409s a claim token that is not the current lease', async () => {
    const order = await insertQueuedOrder();
    await claimJob();

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/heartbeat`, {
      body: { claimToken: 'someone-elses-token' },
    });

    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/cnc/worker/jobs/:orderId/complete', () => {
  it('marks the order ready, stores the manifest and mails the buyer', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();
    const outputKey = `cnc-packs/user-123/${order.licenceId}.zip`;
    getS3ObjectMetadataMock.mockResolvedValue({ contentLength: 4096, contentType: 'application/zip' });

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, {
      body: {
        claimToken: job?.claimToken,
        zipKey: outputKey,
        sizeBytes: 4096,
        sha256: 'a'.repeat(64),
        fingerprintManifest: { seed: 'deadbeef', channels: { jitter: [0.003] } },
        generatorVersion: '1.2.3',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(getS3ObjectMetadataMock).toHaveBeenCalledWith('private', outputKey);

    const ready = await readOrder(order.id);
    expect(ready.status).toBe('ready');
    expect(ready.zipKey).toBe(outputKey);
    expect(ready.zipSizeBytes).toBe(4096);
    expect(ready.zipSha256).toBe('a'.repeat(64));
    expect(ready.fingerprintManifest).toMatchObject({ seed: 'deadbeef', generatorVersion: '1.2.3' });
    // The token is kept, not cleared: it is what makes a retried completion
    // recognisable as a duplicate rather than a stranger's report.
    expect(ready.claimToken).toBe(job?.claimToken);
    expect(sendPackReadyMock).toHaveBeenCalledTimes(1);
  });

  it('409s and leaves the order generating when the uploaded object is a different size', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();
    getS3ObjectMetadataMock.mockResolvedValue({ contentLength: 11, contentType: 'application/zip' });

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, {
      body: {
        claimToken: job?.claimToken,
        zipKey: `cnc-packs/user-123/${order.licenceId}.zip`,
        sizeBytes: 4096,
        sha256: 'b'.repeat(64),
        fingerprintManifest: {},
      },
    });

    expect(res.statusCode).toBe(409);
    expect((await readOrder(order.id)).status).toBe('generating');
    expect(sendPackReadyMock).not.toHaveBeenCalled();
  });

  it('409s when the object is not there at all', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();
    getS3ObjectMetadataMock.mockResolvedValue(null);

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, {
      body: {
        claimToken: job?.claimToken,
        zipKey: `cnc-packs/user-123/${order.licenceId}.zip`,
        sizeBytes: 4096,
        sha256: 'c'.repeat(64),
        fingerprintManifest: {},
      },
    });

    expect(res.statusCode).toBe(409);
    expect((await readOrder(order.id)).status).toBe('generating');
  });

  it('answers a retried completion 200 duplicate without mailing the buyer twice', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();
    const outputKey = `cnc-packs/user-123/${order.licenceId}.zip`;
    getS3ObjectMetadataMock.mockResolvedValue({ contentLength: 4096, contentType: 'application/zip' });
    const completion = {
      claimToken: job?.claimToken,
      zipKey: outputKey,
      sizeBytes: 4096,
      sha256: 'e'.repeat(64),
      fingerprintManifest: { seed: 'deadbeef' },
    };

    const first = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, { body: completion });
    const second = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, { body: completion });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, status: 'ready', duplicate: true });
    // One email, one generation stamp: the redelivery is an answer, not a
    // second transition.
    expect(sendPackReadyMock).toHaveBeenCalledTimes(1);
    expect((await readOrder(order.id)).status).toBe('ready');
  });

  it('409s a completion presenting a token that is not the one that completed the job', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();
    getS3ObjectMetadataMock.mockResolvedValue({ contentLength: 4096, contentType: 'application/zip' });
    await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, {
      body: {
        claimToken: job?.claimToken,
        zipKey: `cnc-packs/user-123/${order.licenceId}.zip`,
        sizeBytes: 4096,
        sha256: 'f'.repeat(64),
        fingerprintManifest: {},
      },
    });
    sendPackReadyMock.mockClear();

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, {
      body: {
        claimToken: 'not-the-token-that-completed-it',
        zipKey: `cnc-packs/user-123/${order.licenceId}.zip`,
        sizeBytes: 4096,
        sha256: 'f'.repeat(64),
        fingerprintManifest: {},
      },
    });

    expect(res.statusCode).toBe(409);
    expect(sendPackReadyMock).not.toHaveBeenCalled();
  });

  it('409s a stale completion after another worker reclaimed the job, leaving the row untouched', async () => {
    const order = await insertQueuedOrder();
    const stale = await claimJob('worker-1');
    // Age the lease past the 10-minute window so the next claim scan takes the
    // row back, exactly as it would for a worker that died mid-job.
    await db
      .update(cncOrders)
      .set({ heartbeatAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(cncOrders.id, order.id));
    const fresh = await claimJob('worker-2');
    expect(fresh?.claimToken).not.toBe(stale?.claimToken);
    const before = await readOrder(order.id);
    getS3ObjectMetadataMock.mockResolvedValue({ contentLength: 4096, contentType: 'application/zip' });

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, {
      body: {
        claimToken: stale?.claimToken,
        zipKey: `cnc-packs/user-123/${order.licenceId}.zip`,
        sizeBytes: 4096,
        sha256: '9'.repeat(64),
        fingerprintManifest: { seed: 'from-the-dead-worker' },
      },
    });

    expect(res.statusCode).toBe(409);
    const after = await readOrder(order.id);
    expect(after.status).toBe('generating');
    expect(after.claimToken).toBe(before.claimToken);
    expect(after.workerId).toBe('worker-2');
    expect(after.generatedAt).toBeNull();
    expect(after.zipKey).toBeNull();
    expect(after.fingerprintManifest).toBeNull();
    expect(sendPackReadyMock).not.toHaveBeenCalled();
  });

  it('409s a pack written to a key this job did not specify', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, {
      body: {
        claimToken: job?.claimToken,
        zipKey: 'cnc-packs/somebody-else/BS-CNC-AAAAAA.zip',
        sizeBytes: 4096,
        sha256: 'd'.repeat(64),
        fingerprintManifest: {},
      },
    });

    expect(res.statusCode).toBe(409);
    expect(getS3ObjectMetadataMock).not.toHaveBeenCalled();
    expect((await readOrder(order.id)).status).toBe('generating');
  });
});

describe('POST /api/cnc/worker/jobs/:orderId/fail', () => {
  it('puts a retryable failure back in the queue with the attempt spent', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/fail`, {
      body: { claimToken: job?.claimToken, errorCode: 'SEAM_TOO_CLOSE_TO_HOLE', message: 'row 12', retryable: true },
    });

    expect(res.statusCode).toBe(200);
    const requeued = await readOrder(order.id);
    expect(requeued.status).toBe('queued');
    expect(requeued.attempts).toBe(1);
    expect(requeued.lastError).toBe('SEAM_TOO_CLOSE_TO_HOLE: row 12');
    expect(requeued.claimToken).toBeNull();
    expect(sendPackFailedMock).not.toHaveBeenCalled();
  });

  it('gives up on the third attempt and mails an operator', async () => {
    const order = await insertQueuedOrder({ attempts: 2 });
    const job = await claimJob();

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/fail`, {
      body: { claimToken: job?.claimToken, errorCode: 'PANEL_EXCEEDS_SHEET', message: 'again', retryable: true },
    });

    expect(res.statusCode).toBe(200);
    const failed = await readOrder(order.id);
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(3);
    expect(sendPackFailedMock).toHaveBeenCalledTimes(1);
  });

  it('goes straight to failed when the worker says the failure is not retryable', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();

    await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/fail`, {
      body: { claimToken: job?.claimToken, errorCode: 'NOT_IMPLEMENTED', message: 'auto placement', retryable: false },
    });

    expect((await readOrder(order.id)).status).toBe('failed');
    expect(sendPackFailedMock).toHaveBeenCalledTimes(1);
  });

  it('409s a failure report against an order that already went ready', async () => {
    // The completing token survives on a `ready` row, so this is the case that
    // proves the status check — not the token check — is what refuses it.
    const order = await insertQueuedOrder();
    const job = await claimJob();
    getS3ObjectMetadataMock.mockResolvedValue({ contentLength: 4096, contentType: 'application/zip' });
    await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/complete`, {
      body: {
        claimToken: job?.claimToken,
        zipKey: `cnc-packs/user-123/${order.licenceId}.zip`,
        sizeBytes: 4096,
        sha256: '1'.repeat(64),
        fingerprintManifest: {},
      },
    });

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/fail`, {
      body: { claimToken: job?.claimToken, errorCode: 'TOO_LATE', message: 'x', retryable: false },
    });

    expect(res.statusCode).toBe(409);
    expect((await readOrder(order.id)).status).toBe('ready');
    expect(sendPackFailedMock).not.toHaveBeenCalled();
  });

  it('accepts a failure message far longer than the column keeps, and truncates it', async () => {
    const order = await insertQueuedOrder();
    const job = await claimJob();

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/fail`, {
      body: {
        claimToken: job?.claimToken,
        errorCode: 'TRACEBACK',
        // Longer than the old 5000-character schema cap: a generator traceback
        // must never turn into a 400 that leaves the order stuck in
        // `generating` with nobody told.
        message: 'x'.repeat(20_000),
        retryable: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const failed = await readOrder(order.id);
    expect(failed.status).toBe('failed');
    expect(failed.lastError?.length).toBe(2000);
    expect(failed.lastError?.startsWith('TRACEBACK: ')).toBe(true);
  });

  it('409s a report from a worker that no longer holds the lease', async () => {
    const order = await insertQueuedOrder();
    await claimJob();

    const res = await callWorker(`/api/cnc/worker/jobs/${String(order.id)}/fail`, {
      body: { claimToken: 'stale-token', errorCode: 'BOOM', message: 'x', retryable: true },
    });

    expect(res.statusCode).toBe(409);
    expect((await readOrder(order.id)).status).toBe('generating');
  });
});

describe('GET /api/cnc/worker/assets/:assetId', () => {
  /** One artwork entry as checkout writes it: the asset id plus the key and mime taken at purchase. */
  const STORED_SVG = {
    assetId: 'asset-1',
    assetKey: 'cnc-art/user-123/0b3f5a1c-1111-4222-8333-444455556666.svg',
    mime: 'image/svg+xml',
    mode: 'engrave',
    placement: COMPLETE_PLACEMENT,
  };

  it('streams the asset the claimed order bought', async () => {
    const order = await insertQueuedOrder({ artwork: [STORED_SVG] });
    const job = await claimJob();
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([Buffer.from('<svg/>')]),
      contentType: 'application/octet-stream',
      contentLength: 6,
    });

    // A real Writable, unlike the plain object every other route here is given:
    // this is the one handler that pipes rather than calling `end`, so the
    // response has to actually be a stream destination.
    const res = await callWorkerStreaming(
      `/api/cnc/worker/assets/asset-1?orderId=${String(order.id)}&claimToken=${String(job?.claimToken)}`,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<svg/>');
    expect(getFromS3Mock).toHaveBeenCalledWith('private', STORED_SVG.assetKey);
    // The mime we sniffed at upload wins over whatever the bucket reports,
    // and `nosniff` holds the generator to it.
    expect(res.headers['Content-Type']).toBe('image/svg+xml');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('404s an asset id this order never bought', async () => {
    const order = await insertQueuedOrder({ artwork: [STORED_SVG] });
    const job = await claimJob();

    const res = await callWorker(
      `/api/cnc/worker/assets/asset-2?orderId=${String(order.id)}&claimToken=${String(job?.claimToken)}`,
      { method: 'GET' },
    );

    expect(res.statusCode).toBe(404);
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });

  it('404s without reading storage when the stored key is not an artwork key', async () => {
    // The private bucket also holds user data exports, so a key that reached
    // the JSON column through some future bug must never become a read.
    const order = await insertQueuedOrder({
      artwork: [{ ...STORED_SVG, assetKey: 'exports/user-999/data.zip' }],
    });
    const job = await claimJob();

    const res = await callWorker(
      `/api/cnc/worker/assets/asset-1?orderId=${String(order.id)}&claimToken=${String(job?.claimToken)}`,
      { method: 'GET' },
    );

    expect(res.statusCode).toBe(404);
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });

  it('404s when the order names an asset that is missing from storage', async () => {
    const order = await insertQueuedOrder({ artwork: [STORED_SVG] });
    const job = await claimJob();
    getFromS3Mock.mockResolvedValue(null);

    const res = await callWorker(
      `/api/cnc/worker/assets/asset-1?orderId=${String(order.id)}&claimToken=${String(job?.claimToken)}`,
      { method: 'GET' },
    );

    expect(res.statusCode).toBe(404);
  });

  it('409s an asset request that does not carry the current lease', async () => {
    const order = await insertQueuedOrder({ artwork: [STORED_SVG] });
    await claimJob();

    const res = await callWorker(
      `/api/cnc/worker/assets/asset-1?orderId=${String(order.id)}&claimToken=not-the-lease`,
      { method: 'GET' },
    );

    expect(res.statusCode).toBe(409);
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });
});

describe('reaping a job whose worker never came back', () => {
  /**
   * A row abandoned mid-generation on its final attempt: `generating`, the
   * attempt budget spent, and a heartbeat old enough that the lease is gone.
   * Nothing will ever claim it again — the claim's candidate filter excludes
   * `attempts >= CNC_MAX_ATTEMPTS` — so the reaper is its only way out.
   */
  async function insertAbandonedFinalAttempt() {
    return insertQueuedOrder({
      status: 'generating',
      attempts: 3,
      claimToken: 'token-from-the-dead-worker',
      workerId: 'worker-that-died',
      claimedAt: new Date(Date.now() - 3_600_000),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
  }

  it('fails it on the next claim and tells an operator', async () => {
    const abandoned = await insertAbandonedFinalAttempt();

    const job = await claimJob();

    expect(job).toBeNull();
    const reaped = await readOrder(abandoned.id);
    expect(reaped.status).toBe('failed');
    expect(reaped.claimToken).toBeNull();
    expect(reaped.lastError).toContain('Lease expired');
    // The dead worker cannot report its own failure, so the claim is the only
    // place an operator can be told a paid order gave up.
    expect(sendPackFailedMock).toHaveBeenCalledTimes(1);
    expect(sendPackFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: abandoned.id,
        licenceId: abandoned.licenceId,
        licenseeEmail: 'marco@example.com',
        attempts: 3,
      }),
    );
  });

  it('still hands out the next queued order in the same poll', async () => {
    await insertAbandonedFinalAttempt();
    const waiting = await insertQueuedOrder();

    const job = await claimJob();

    expect(job).toMatchObject({ orderId: waiting.id });
    expect(sendPackFailedMock).toHaveBeenCalledTimes(1);
  });

  it('mails once, not on every poll', async () => {
    await insertAbandonedFinalAttempt();

    await claimJob();
    await claimJob();

    expect(sendPackFailedMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a live lease alone', async () => {
    const alive = await insertQueuedOrder({
      status: 'generating',
      attempts: 3,
      claimToken: 'a-live-lease',
      workerId: 'worker-still-working',
      claimedAt: new Date(),
      heartbeatAt: new Date(),
    });

    await claimJob();

    expect((await readOrder(alive.id)).status).toBe('generating');
    expect(sendPackFailedMock).not.toHaveBeenCalled();
  });
});

describe('order ids in the job path', () => {
  it.each(['0', '00', '000000'])('400s order id %s rather than looking it up', async (orderId) => {
    const res = await callWorker(`/api/cnc/worker/jobs/${orderId}/heartbeat`, { body: { claimToken: 'anything' } });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid order id');
  });

  it('400s an order id too long to be an integer', async () => {
    const res = await callWorker(`/api/cnc/worker/jobs/${'9'.repeat(30)}/complete`, {
      body: {
        claimToken: 'anything',
        zipKey: 'cnc-packs/user-123/BS-CNC-ABCDEF.zip',
        sizeBytes: 1,
        sha256: 'a'.repeat(64),
        fingerprintManifest: {},
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/cnc/worker/assets/:assetId — unleased (pre-purchase)', () => {
  /**
   * `validateCncArtwork` runs before checkout, so there is no order yet to
   * lease against — the worker fetches the asset by id with the fleet secret
   * alone.
   */
  async function insertAsset(assetId: string, mime = 'image/svg+xml') {
    return createArtAsset({
      id: assetId,
      userId: 'user-123',
      key: cncArtAssetKey('user-123', assetId, mime === 'image/png' ? 'png' : 'svg'),
      mime,
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
    });
  }

  it('streams the asset by id alone when orderId and claimToken are both absent', async () => {
    const asset = await insertAsset('asset-1');
    getFromS3Mock.mockResolvedValue({
      stream: Readable.from([Buffer.from('<svg/>')]),
      contentType: 'application/octet-stream',
      contentLength: 6,
    });

    const res = await callWorkerStreaming('/api/cnc/worker/assets/asset-1');

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<svg/>');
    expect(getFromS3Mock).toHaveBeenCalledWith('private', asset.key);
    expect(res.headers['Content-Type']).toBe('image/svg+xml');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="asset-1.svg"');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('401s the unleased fetch without the worker secret', async () => {
    await insertAsset('asset-1');

    const res = await callWorker('/api/cnc/worker/assets/asset-1', { method: 'GET', secret: 'wrong-secret' });

    expect(res.statusCode).toBe(401);
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });

  it('400s when only one of orderId/claimToken is present', async () => {
    await insertAsset('asset-1');
    const order = await insertQueuedOrder();

    const missingClaimToken = await callWorker(`/api/cnc/worker/assets/asset-1?orderId=${String(order.id)}`, {
      method: 'GET',
    });
    expect(missingClaimToken.statusCode).toBe(400);

    const missingOrderId = await callWorker('/api/cnc/worker/assets/asset-1?claimToken=some-token', {
      method: 'GET',
    });
    expect(missingOrderId.statusCode).toBe(400);

    expect(getFromS3Mock).not.toHaveBeenCalled();
  });

  it('500s and refuses to serve an asset whose content type is outside the allowlist', async () => {
    // Every real upload is sniffed against the same allowlist at write time,
    // so reaching this is an asset that should never have been storable —
    // guessing a Content-Type for it is worse than refusing to serve it.
    await insertAsset('asset-1', 'application/pdf');

    const res = await callWorker('/api/cnc/worker/assets/asset-1', { method: 'GET' });

    expect(res.statusCode).toBe(500);
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });

  it('404s an unleased fetch for an asset id that does not exist', async () => {
    const res = await callWorker('/api/cnc/worker/assets/no-such-asset', { method: 'GET' });

    expect(res.statusCode).toBe(404);
    expect(getFromS3Mock).not.toHaveBeenCalled();
  });
});
