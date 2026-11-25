import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  CATALOG_ADMISSION_PATH,
  CATALOG_PROOF_HEADER,
  signCatalogRequest,
} from '@boardsesh/crypto/catalog-request-proof';

const { reserve, release } = vi.hoisted(() => ({ reserve: vi.fn(), release: vi.fn() }));
vi.mock('../utils/catalog-budget', () => ({
  reserveCatalogAccess: reserve,
  releaseCatalogAccess: release,
  CatalogRateLimitError: class extends Error {
    code = 'RATE_LIMITED';
    constructor(
      public retryAfterSeconds: number,
      public reason: string,
    ) {
      super('Rate limited');
    }
  },
}));

import { CatalogRateLimitError } from '../utils/catalog-budget';
import { handleCatalogAdmission } from '../handlers/catalog-admission';

const SECRET = 'catalog-admission-test-secret';
const CLIENT_IP = '203.0.113.8';
const LEASE = {
  id: '95e2f4bc-38ca-46f8-b9d2-a2195f8fbf01',
  expiresAt: 1_800_000_000_000,
  requestedRows: 50,
  lane: 'interactive',
  mode: 'redis',
};

async function call(
  command: Record<string, unknown>,
  options: { headers?: Record<string, string | undefined>; body?: string; signedAt?: number; method?: string } = {},
) {
  const signedBody = JSON.stringify(command);
  const request = Readable.from([Buffer.from(options.body ?? signedBody)]) as IncomingMessage;
  request.method = options.method ?? 'POST';
  request.headers = {
    [CATALOG_PROOF_HEADER]: signCatalogRequest(
      {
        purpose: command.action === 'release' ? 'release' : 'reserve',
        method: 'POST',
        pathname: CATALOG_ADMISSION_PATH,
        clientIp: CLIENT_IP,
        body: signedBody,
      },
      SECRET,
      options.signedAt,
    ),
    ...options.headers,
  };
  const writeHead = vi.fn();
  const end = vi.fn();
  const response = { writeHead, end } as unknown as ServerResponse;
  expect(await handleCatalogAdmission(request, response, CATALOG_ADMISSION_PATH)).toBe(true);
  return {
    status: writeHead.mock.calls[0][0],
    headers: writeHead.mock.calls[0][1],
    body: JSON.parse(end.mock.calls[0][0]),
  };
}

describe('internal catalog admission', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', SECRET);
    reserve.mockReset().mockResolvedValue(LEASE);
    release.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reserves backend-selected work and rows for the verified visitor', async () => {
    const response = await call({ action: 'reserve', operation: 'restsetters' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ lease: LEASE });
    expect(reserve).toHaveBeenCalledWith(
      { trustedClientIp: CLIENT_IP },
      { operation: 'restsetters', lane: 'interactive', requestedRows: 50, workUnits: 10 },
    );
    expect(response.headers['Cache-Control']).toBe('no-store');
  });

  it.each([
    { headers: { [CATALOG_PROOF_HEADER]: '' } },
    { headers: { origin: 'https://www.boardsesh.com' } },
    { headers: { origin: '' } },
    { method: 'GET' },
    { signedAt: Date.now() - 120_000 },
    { body: JSON.stringify({ action: 'reserve', operation: 'restclimb' }) },
  ])('refuses unsigned, browser, expired or altered commands: %j', async (options) => {
    expect((await call({ action: 'reserve', operation: 'restsetters' }, options)).status).toBe(403);
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'reserve', operation: '__proto__' },
    { action: 'reserve', operation: 'syncClimbs' },
    { action: 'reserve', operation: 'restclimb', requestedRows: 0 },
  ])('does not accept arbitrary operations or client costs: %j', async (command) => {
    expect((await call(command)).status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('bounds streamed and declared body lengths', async () => {
    const command = { action: 'reserve', operation: 'restclimb' };
    expect((await call(command, { body: 'x'.repeat(2049) })).status).toBe(413);
    expect((await call(command, { headers: { 'content-length': '2049' } })).status).toBe(413);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('releases only a validated lease with bounded actual row count', async () => {
    expect((await call({ action: 'release', lease: LEASE, actualRows: 7 })).status).toBe(200);
    expect(release).toHaveBeenCalledWith(LEASE, 7);
    release.mockClear();
    for (const lease of [
      { ...LEASE, id: 'arbitrary-key' },
      { ...LEASE, keys: ['anything'] },
      { ...LEASE, id: '', mode: 'disabled' },
      { ...LEASE, lane: 'sync' },
    ]) {
      expect((await call({ action: 'release', lease, actualRows: 7 })).status).toBe(400);
    }
    expect((await call({ action: 'release', lease: LEASE, actualRows: 51 })).status).toBe(400);
    expect(release).not.toHaveBeenCalled();
  });

  it('does not claim unused rows when a read failed', async () => {
    expect((await call({ action: 'release', lease: LEASE, actualRows: null })).status).toBe(200);
    expect(release).toHaveBeenCalledWith(LEASE, undefined);
  });

  it('returns a non-cacheable 429 with migration instructions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T00:00:00Z'));
    reserve.mockRejectedValue(new CatalogRateLimitError(42, 'work'));
    const response = await call({ action: 'reserve', operation: 'restclimb' });
    expect(response.status).toBe(429);
    expect(response.headers).toMatchObject({ 'Retry-After': '42', 'Cache-Control': 'no-store' });
    expect(response.body).toMatchObject({
      code: 'RATE_LIMITED',
      limitReason: 'work',
      snapshotManifestUrl: expect.stringContaining('/manifest.json'),
    });
    expect(response.body).not.toHaveProperty('lease');
  });
});
