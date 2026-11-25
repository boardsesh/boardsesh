// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextResponse } from 'next/server';
import {
  CATALOG_ADMISSION_PATH,
  CATALOG_PROOF_HEADER,
  verifyCatalogRequest,
} from '@boardsesh/crypto/catalog-request-proof';
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/backend-url', () => ({ getBackendHttpUrl: () => 'https://backend.test' }));
vi.mock('@/app/lib/auth/trusted-client-ip.server', () => ({ trustedClientRateLimitKey: () => '203.0.113.8' }));
import { withCatalogAdmission } from '../catalog-admission.server';

const SECRET = 'catalog-admission-test-secret';
const LEASE = { id: 'lease-id', requestedRows: 50 };
const request = new Request('https://www.boardsesh.com/api/v1/kilter/setters');

describe('REST catalog admission adapter', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T09:00:00Z'));
    vi.stubEnv('NEXTAUTH_SECRET', SECRET);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(Response.json({ lease: LEASE }))
      .mockResolvedValue(Response.json({ released: true }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('requires admission immediately, including dates before December 2026', async () => {
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    vi.stubEnv('NEXTAUTH_SECRET', '');
    const work = vi.fn(async () => NextResponse.json({ found: true }));
    const response = await withCatalogAdmission(request, 'restclimb', work);
    expect(response.status).toBe(503);
    expect(work).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds the lease throughout work, signs both bodies, and refunds actual rows', async () => {
    let finishWork: (() => void) | undefined;
    const workStarted = vi.fn();
    const pending = withCatalogAdmission(request, 'restsetters', async (recordRows) => {
      workStarted();
      await new Promise<void>((resolve) => {
        finishWork = resolve;
      });
      recordRows(7);
      return NextResponse.json({ found: true });
    });
    await vi.waitFor(() => expect(workStarted).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishWork?.();
    const response = await pending;
    expect(await response.json()).toEqual({ found: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [index, purpose] of ['reserve', 'release'].entries()) {
      const [url, options] = fetchMock.mock.calls[index];
      const body = options?.body as string;
      expect(url).toBe(`https://backend.test${CATALOG_ADMISSION_PATH}`);
      expect(
        verifyCatalogRequest(
          new Headers(options?.headers).get(CATALOG_PROOF_HEADER),
          { purpose: purpose as 'reserve' | 'release', method: 'POST', pathname: CATALOG_ADMISSION_PATH, body },
          SECRET,
        ),
      ).toEqual({ clientIp: '203.0.113.8' });
      expect(new Headers(options?.headers).has('Origin')).toBe(false);
      expect(options).toMatchObject({ cache: 'no-store', redirect: 'error' });
    }
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      action: 'release',
      lease: LEASE,
      actualRows: 7,
    });
  });

  it.each(['work', 'rows', 'concurrency', 'capacity'])(
    'returns a non-cacheable %s refusal before database work',
    async (limitReason) => {
      fetchMock
        .mockReset()
        .mockResolvedValue(
          new Response(JSON.stringify({ limitReason }), { status: 429, headers: { 'Retry-After': '42' } }),
        );
      const work = vi.fn(async () => NextResponse.json({ found: true }));
      const response = await withCatalogAdmission(request, 'restclimb', work);
      expect(work).not.toHaveBeenCalled();
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('42');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toMatchObject({
        code: 'RATE_LIMITED',
        limitReason,
        snapshotManifestUrl: expect.stringContaining('/manifest.json'),
      });
    },
  );

  it.each([null, JSON.stringify({ limitReason: 'unknown upstream detail' })])(
    'preserves 429 when its reason is unavailable',
    async (body) => {
      fetchMock.mockReset().mockResolvedValue(new Response(body, { status: 429, headers: { 'Retry-After': '42' } }));
      const work = vi.fn(async () => NextResponse.json({ found: true }));
      const response = await withCatalogAdmission(request, 'restclimb', work);
      expect(response.status).toBe(429);
      expect((await response.json()).limitReason).toBeUndefined();
      expect(work).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the secret or admission service is unavailable', async () => {
    const work = vi.fn(async () => NextResponse.json({ found: true }));
    fetchMock.mockReset().mockRejectedValue(new Error('upstream unavailable'));
    expect((await withCatalogAdmission(request, 'restclimb', work)).status).toBe(503);
    vi.stubEnv('NEXTAUTH_SECRET', '');
    expect((await withCatalogAdmission(request, 'restclimb', work)).status).toBe(503);
    expect(work).not.toHaveBeenCalled();
  });

  it('releases after failed work and preserves the original error', async () => {
    const failure = new Error('query failed');
    await expect(
      withCatalogAdmission(request, 'reststats', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      action: 'release',
      lease: LEASE,
      actualRows: null,
    });
  });
});
