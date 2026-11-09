import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitError } from '../utils/rate-limiter';

const { renderFamily, ensureRenderer, FakeSaturated } = vi.hoisted(() => {
  class FakeSaturated extends Error {}
  return { renderFamily: vi.fn(), ensureRenderer: vi.fn(async () => true), FakeSaturated };
});

vi.mock('../services/board-render', () => ({
  RenderQueueSaturatedError: FakeSaturated,
  ensureBoardRendererAvailable: ensureRenderer,
  renderOgFamilyArt: renderFamily,
  buildOgFamilyByteKey: (surface: string, digest: string) => `key:${surface}:${digest}`,
}));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => {}) }));
vi.mock('../services/og-family/load-cards', () => ({
  loadPlaylistCard: vi.fn(),
  loadProfileCard: vi.fn(),
  loadSessionJoinCard: vi.fn(),
  loadSessionRecapCard: vi.fn(),
  loadSetterCard: vi.fn(),
}));

import { handleOgPlaylist, handleOgProfile, handleOgSession, handleOgSetter } from '../handlers/og-family';
import {
  loadPlaylistCard,
  loadProfileCard,
  loadSessionJoinCard,
  loadSessionRecapCard,
  loadSetterCard,
} from '../services/og-family/load-cards';
import { OgFamilyNotFoundError } from '../services/og-family/run-document';
import { CardReadsSaturatedError } from '../services/og-family/card-read-limit';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';

type MockRes = {
  statusCode: number;
  body: string | Buffer | undefined;
  headers: Record<string, unknown>;
  writeHead: (status: number, headers?: Record<string, unknown>) => void;
  end: (body?: string | Buffer) => void;
  setHeader: (name: string, value: unknown) => void;
};

function makeRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      if (body !== undefined) this.body = body;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

function makeReq(method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  return { method, headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
}

const loadedCard = {
  digest: 'abc',
  art: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', frames: '' },
  content: { slot: 'full' as const, hero: { runs: [], maxPt: 60, wrap: true }, rows: [] },
};
const artlessCard = { ...loadedCard, art: null, content: { ...loadedCard.content, slot: 'none' as const } };

const url = (path: string) => new URL(`http://localhost:8080${path}`);

async function callPlaylist(
  path = '/og/playlist?uuid=playlist-uuid',
  method = 'GET',
  headers: Record<string, string> = {},
) {
  const res = makeRes();
  await handleOgPlaylist(makeReq(method, headers), res as unknown as ServerResponse, url(path));
  return res;
}
async function callSession(path: string, method = 'GET') {
  const res = makeRes();
  await handleOgSession(makeReq(method), res as unknown as ServerResponse, url(path));
  return res;
}

const notFoundBody = '{"error":"Not found"}';

describe('family card handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureRenderer.mockResolvedValue(true);
    vi.mocked(checkRateLimitRedis).mockResolvedValue(undefined);
    vi.mocked(loadPlaylistCard).mockResolvedValue(loadedCard);
    vi.mocked(loadSessionJoinCard).mockResolvedValue(loadedCard);
    renderFamily.mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8]),
      contentType: 'image/jpeg',
      cache: 'miss',
      timings: { wasmMs: 1, planeMs: 2, composeMs: 3 },
    });
  });

  it('serves an image with private no-store headers', async () => {
    const res = await callPlaylist();

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(res.headers['CDN-Cache-Control']).toBe('no-store');
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(res.headers).not.toHaveProperty('Vercel-CDN-Cache-Control');
    expect(res.body).toBeInstanceOf(Buffer);
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await callPlaylist('/og/playlist?uuid=playlist-uuid', 'HEAD');

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Length']).toBe(2);
    expect(res.body).toBeUndefined();
  });

  it('keys the byte cache on surface and digest, and ignores a format param', async () => {
    await callPlaylist('/og/playlist?uuid=playlist-uuid&format=png');

    expect(renderFamily.mock.calls[0][0].cacheKey).toBe('key:playlist:abc');
    expect(renderFamily.mock.calls[0][0]).not.toHaveProperty('format');
  });

  it.each([
    ['a missing uuid', '/og/playlist'],
    ['a hostile uuid', '/og/playlist?uuid=%3Cscript%3E'],
    ['an oversized uuid', `/og/playlist?uuid=${'a'.repeat(101)}`],
  ])('answers the same 404 for %s, before any load', async (_label, path) => {
    const res = await callPlaylist(path);

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(notFoundBody);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(loadPlaylistCard).not.toHaveBeenCalled();
    expect(renderFamily).not.toHaveBeenCalled();
  });

  it('answers a card the gate refused with the same 404, with no render or cache read', async () => {
    vi.mocked(loadPlaylistCard).mockResolvedValue(null);

    const res = await callPlaylist();

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(notFoundBody);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(renderFamily).not.toHaveBeenCalled();
  });

  it('maps an allow-listed resolver refusal to the same 404', async () => {
    vi.mocked(loadPlaylistCard).mockRejectedValue(new OgFamilyNotFoundError());

    const res = await callPlaylist();

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(notFoundBody);
    expect(renderFamily).not.toHaveBeenCalled();
  });

  it('answers any other load failure with a 500', async () => {
    vi.mocked(loadPlaylistCard).mockRejectedValue(new Error('database down'));

    const res = await callPlaylist();

    expect(res.statusCode).toBe(500);
    expect(renderFamily).not.toHaveBeenCalled();
  });

  it('rejects past the rate limit, before any load', async () => {
    vi.mocked(checkRateLimitRedis).mockRejectedValueOnce(new RateLimitError(12));

    const res = await callPlaylist();

    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('12');
    expect(loadPlaylistCard).not.toHaveBeenCalled();
  });

  it('checks the same IP and peer limits as the climb card', async () => {
    await callPlaylist();

    expect(vi.mocked(checkRateLimitRedis).mock.calls.map((call) => call.slice(1))).toEqual([
      ['og-family', 120, 60_000],
      ['og-family-peer', 600, 60_000],
    ]);
  });

  it('ignores the Authorization header entirely', async () => {
    vi.mocked(loadPlaylistCard).mockResolvedValue(null);

    const withAuth = await callPlaylist('/og/playlist?uuid=playlist-uuid', 'GET', { authorization: 'Bearer stolen' });
    const withoutAuth = await callPlaylist();

    expect(withAuth.statusCode).toBe(404);
    expect(withAuth.body).toBe(withoutAuth.body);
    expect(renderFamily).not.toHaveBeenCalled();
  });

  it('503s without the WASM renderer when a card needs art', async () => {
    ensureRenderer.mockResolvedValue(false);

    const res = await callPlaylist();

    expect(res.statusCode).toBe(503);
    expect(renderFamily).not.toHaveBeenCalled();
  });

  it('still serves an artless card when the WASM renderer is down', async () => {
    ensureRenderer.mockResolvedValue(false);
    vi.mocked(loadPlaylistCard).mockResolvedValue(artlessCard);

    const res = await callPlaylist();

    expect(res.statusCode).toBe(200);
    expect(ensureRenderer).not.toHaveBeenCalled();
  });

  it('answers a saturated render queue with 503 and Retry-After', async () => {
    renderFamily.mockRejectedValue(new FakeSaturated('Render queue is saturated'));

    const res = await callPlaylist();

    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('5');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  describe('/og/session', () => {
    it.each([
      ['an unknown variant', '/og/session?sessionId=abc&variant=recap'],
      ['a missing id', '/og/session?variant=join'],
      ['a hostile id', '/og/session?sessionId=%3Cscript%3E'],
      ['a NUL in the id', '/og/session?sessionId=abc%00def'],
    ])('answers the same 404 for %s, before any load', async (_label, path) => {
      const res = await callSession(path);

      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(notFoundBody);
      expect(loadSessionJoinCard).not.toHaveBeenCalled();
      expect(loadSessionRecapCard).not.toHaveBeenCalled();
    });

    it('serves the recap with no variant', async () => {
      vi.mocked(loadSessionRecapCard).mockResolvedValue(artlessCard);

      const res = await callSession('/og/session?sessionId=abc');

      expect(res.statusCode).toBe(200);
      expect(loadSessionRecapCard).toHaveBeenCalledWith('abc', expect.any(String));
      expect(loadSessionJoinCard).not.toHaveBeenCalled();
      expect(renderFamily.mock.calls[0][0].cacheKey).toBe('key:session-recap:abc');
    });

    it('serves the join variant', async () => {
      const res = await callSession('/og/session?sessionId=abc&variant=join');

      expect(res.statusCode).toBe(200);
      expect(loadSessionJoinCard).toHaveBeenCalledWith('abc', expect.any(String));
      expect(loadSessionRecapCard).not.toHaveBeenCalled();
    });

    it('serves the recap for an invite to an ended session', async () => {
      vi.mocked(loadSessionJoinCard).mockResolvedValue(null);
      vi.mocked(loadSessionRecapCard).mockResolvedValue(artlessCard);

      const res = await callSession('/og/session?sessionId=abc&variant=join');

      expect(res.statusCode).toBe(200);
      expect(loadSessionRecapCard).toHaveBeenCalledWith('abc', expect.any(String));
    });

    it('answers an ended session with nothing to recap with the same 404', async () => {
      vi.mocked(loadSessionJoinCard).mockResolvedValue(null);
      vi.mocked(loadSessionRecapCard).mockResolvedValue(null);

      const res = await callSession('/og/session?sessionId=abc&variant=join');

      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(notFoundBody);
      expect(renderFamily).not.toHaveBeenCalled();
    });
  });

  describe('/og/profile', () => {
    const callProfile = async (path: string) => {
      const res = makeRes();
      await handleOgProfile(makeReq(), res as unknown as ServerResponse, url(path));
      return res;
    };

    it('answers no-store with a JPEG for a card that passed its gate', async () => {
      vi.mocked(loadProfileCard).mockResolvedValue(artlessCard);

      const res = await callProfile('/og/profile?user_id=abc-1_2');

      expect(res.statusCode).toBe(200);
      expect(String(res.headers['Cache-Control'])).toMatch(/no-store/);
      expect(renderFamily).toHaveBeenCalledOnce();
    });

    it.each([
      ['a missing id', '/og/profile'],
      ['a hostile id', '/og/profile?user_id=%3Cscript%3E'],
      ['a NUL in the id', '/og/profile?user_id=abc%00def'],
      ['an oversized id', `/og/profile?user_id=${'a'.repeat(101)}`],
    ])('answers the same 404 for %s, before any load', async (_label, path) => {
      const res = await callProfile(path);

      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(notFoundBody);
      expect(loadProfileCard).not.toHaveBeenCalled();
    });

    it('sheds with a 503 and Retry-After when card reads are saturated, logging no failure', async () => {
      vi.mocked(loadProfileCard).mockRejectedValue(new CardReadsSaturatedError());

      const res = await callProfile('/og/profile?user_id=abc');

      expect(res.statusCode).toBe(503);
      expect(res.headers['Retry-After']).toBe('5');
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(renderFamily).not.toHaveBeenCalled();
    });

    it('answers a gate refusal with the same 404', async () => {
      vi.mocked(loadProfileCard).mockResolvedValue(null);

      const res = await callProfile('/og/profile?user_id=abc');

      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(notFoundBody);
      expect(renderFamily).not.toHaveBeenCalled();
    });
  });

  describe('/og/setter', () => {
    const callSetter = async (path: string) => {
      const res = makeRes();
      await handleOgSetter(makeReq(), res as unknown as ServerResponse, url(path));
      return res;
    };

    it('accepts a setter name in any script', async () => {
      vi.mocked(loadSetterCard).mockResolvedValue(artlessCard);

      const res = await callSetter(`/og/setter?username=${encodeURIComponent('Коваленко')}`);

      expect(res.statusCode).toBe(200);
      expect(loadSetterCard).toHaveBeenCalledWith('Коваленко', expect.any(String));
    });

    it.each([
      ['a missing name', '/og/setter'],
      ['an empty name', '/og/setter?username='],
      ['an oversized name', `/og/setter?username=${'a'.repeat(101)}`],
      ['a NUL in the name', '/og/setter?username=abc%00def'],
      ['a newline in the name', '/og/setter?username=abc%0Adef'],
    ])('answers the same 404 for %s, before any load', async (_label, path) => {
      const res = await callSetter(path);

      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(notFoundBody);
      expect(loadSetterCard).not.toHaveBeenCalled();
    });
  });
});
