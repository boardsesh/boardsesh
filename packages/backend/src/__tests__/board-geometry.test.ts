import { gunzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBoardGeometry, isBoardGeometryPath, resetBoardGeometryCache } from '../handlers/board-geometry';
import { loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import { RateLimitError } from '../utils/rate-limiter';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';

vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => {}) }));

// Spied rather than stubbed: every other case wants the real shards, and only
// the eviction test makes it throw.
vi.mock('@boardsesh/board-art-geometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-art-geometry')>();
  return { ...actual, loadBoardArtGeometry: vi.fn(actual.loadBoardArtGeometry) };
});

type CapturedResponse = { status: number; headers: Record<string, string>; body: Buffer };

function callGeometry(query: string, headers: Record<string, string> = {}, method = 'GET'): Promise<CapturedResponse> {
  const setHeaders: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let status = 0;

  return new Promise((resolve, reject) => {
    const res = {
      setHeader: (name: string, value: string) => {
        setHeaders[name] = value;
      },
      writeHead: (code: number, headerBag?: Record<string, string | number>) => {
        status = code;
        for (const [name, value] of Object.entries(headerBag ?? {})) setHeaders[name] = String(value);
      },
      end: (chunk?: Buffer | string) => {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve({ status, headers: setHeaders, body: Buffer.concat(chunks) });
      },
    } as unknown as ServerResponse;

    const req = { method, headers, socket: { remoteAddress: '10.0.0.1' } } as unknown as IncomingMessage;
    // Surfaced rather than voided: a handler that throws never calls `end`, so
    // without this the promise would hang and the failure would read as a
    // timeout instead of the error that caused it. The real server has a
    // route-level catch that turns this into a 500.
    handleBoardGeometry(req, res, new URL(`https://ws.boardsesh.com/render/geometry?${query}`)).catch(reject);
  });
}

function decode(response: CapturedResponse): Record<string, unknown> {
  const raw = response.headers['Content-Encoding'] === 'gzip' ? gunzipSync(response.body) : response.body;
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

afterEach(() => {
  resetBoardGeometryCache();
  vi.mocked(checkRateLimitRedis).mockReset();
  vi.mocked(checkRateLimitRedis).mockImplementation(() => Promise.resolve());
});

describe('isBoardGeometryPath', () => {
  it('answers on the canonical path and the same-origin alias web rewrites to', () => {
    expect(isBoardGeometryPath('/render/geometry')).toBe(true);
    expect(isBoardGeometryPath('/api/internal/board-geometry')).toBe(true);
    expect(isBoardGeometryPath('/render/board')).toBe(false);
  });
});

describe('GET /render/geometry', () => {
  it('hands over the traced art for one board config', async () => {
    const response = await callGeometry('board_name=kilter&layout_id=1&size_id=10');
    expect(response.status).toBe(200);

    const payload = decode(response) as {
      outlines: Record<string, number[]>;
      ledBright: Record<string, [number, number]>;
      silhouetteLightness: Record<string, number>;
      wallLightness: { mean: number; coverage: number };
    };
    expect(Object.keys(payload.outlines).length).toBeGreaterThan(100);
    // Flat [x0, y0, x1, y1, …] in units of the placement's own radius.
    expect(Object.values(payload.outlines)[0].length % 2).toBe(0);
    expect(payload.wallLightness.mean).toBeGreaterThan(0);
    expect(payload.silhouetteLightness).toBeDefined();
  });

  it('answers 200 with an empty body for a config the tracer skipped', async () => {
    // Not a 404: "this board has no silhouettes" is a normal answer the renderer
    // handles by glowing a ring at each placement radius, and a 404 would make
    // every caller special-case it.
    const response = await callGeometry('board_name=kilter&layout_id=999&size_id=999');
    expect(response.status).toBe(200);
    expect(decode(response)).toEqual({});
  });

  it('caches immutably only when the render version names the bytes', async () => {
    const versioned = await callGeometry('board_name=kilter&layout_id=1&size_id=10&v=0123456789ab');
    expect(versioned.headers['Cache-Control']).toContain('immutable');

    const unversioned = await callGeometry('board_name=kilter&layout_id=1&size_id=10');
    expect(unversioned.headers['Cache-Control']).not.toContain('immutable');

    const malformed = await callGeometry('board_name=kilter&layout_id=1&size_id=10&v=not-a-version');
    expect(malformed.headers['Cache-Control']).not.toContain('immutable');
  });

  it('gzips for a browser and stays plain for a client that cannot take it', async () => {
    const gzipped = await callGeometry('board_name=kilter&layout_id=1&size_id=10', { 'accept-encoding': 'gzip, br' });
    expect(gzipped.headers['Content-Encoding']).toBe('gzip');
    expect(gzipped.headers.Vary).toBe('Accept-Encoding');

    const plain = await callGeometry('board_name=kilter&layout_id=1&size_id=10');
    expect(plain.headers['Content-Encoding']).toBeUndefined();
    // Worth the encode: the biggest config is the one that reaches a browser most.
    expect(gzipped.body.length).toBeLessThan(plain.body.length / 2);
  });

  it('answers a preflight without touching the shards', async () => {
    const response = await callGeometry('board_name=kilter&layout_id=1&size_id=10', {}, 'OPTIONS');
    expect(response.status).toBe(200);
    expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, HEAD, OPTIONS');
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(response.body.length).toBe(0);
  });

  it('answers HEAD with the real headers and no body', async () => {
    const head = await callGeometry('board_name=kilter&layout_id=1&size_id=10&v=0123456789ab', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['Cache-Control']).toContain('immutable');
    // Content-Length still describes the body a GET would return.
    expect(Number(head.headers['Content-Length'])).toBeGreaterThan(0);
    expect(head.body.length).toBe(0);
  });

  it('sheds with a 429 and a Retry-After rather than reading the shards', async () => {
    vi.mocked(checkRateLimitRedis).mockRejectedValueOnce(new RateLimitError(30));

    const response = await callGeometry('board_name=kilter&layout_id=1&size_id=10');
    expect(response.status).toBe(429);
    expect(response.headers['Retry-After']).toBe('30');
    // A shed response must never be cached, or the edge would serve the 429 in
    // place of the geometry for as long as it held it.
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(response.body.toString())).toEqual({ error: 'Rate limit exceeded' });
  });

  it('checks the caller and the socket peer, in that order', async () => {
    await callGeometry('board_name=kilter&layout_id=1&size_id=10');

    expect(vi.mocked(checkRateLimitRedis).mock.calls.map(([, bucket]) => bucket)).toEqual([
      'board-geometry',
      'board-geometry-peer',
    ]);
  });

  it('does not cache a failed encode, so the next request can succeed', async () => {
    // The trap this guards: the encode is memoised on the promise so a burst of
    // requests for one board compresses once. Keeping a REJECTED promise would
    // answer every later request for that board with the same failure for the
    // rest of the process lifetime, for every client, recoverable only by a
    // restart.
    vi.mocked(loadBoardArtGeometry).mockImplementationOnce(() => {
      throw new Error('shard read failed');
    });

    await expect(callGeometry('board_name=kilter&layout_id=1&size_id=10')).rejects.toThrow('shard read failed');

    const recovered = await callGeometry('board_name=kilter&layout_id=1&size_id=10');
    expect(recovered.status).toBe(200);
    expect(Object.keys((decode(recovered) as { outlines: Record<string, number[]> }).outlines).length).toBeGreaterThan(
      0,
    );
  });

  it('rejects a board it does not serve, and non-integer ids', async () => {
    expect((await callGeometry('board_name=nope&layout_id=1&size_id=10')).status).toBe(400);
    expect((await callGeometry('board_name=kilter&layout_id=-1&size_id=10')).status).toBe(400);
    expect((await callGeometry('board_name=kilter&layout_id=1&size_id=x')).status).toBe(400);
    expect((await callGeometry('layout_id=1&size_id=10')).status).toBe(400);
  });
});
