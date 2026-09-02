import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { MAX_SET_IDS_LENGTH } from '@boardsesh/board-render';
import { RateLimitError } from '../utils/rate-limiter';

// The handler under test talks to the board-render service and the Redis rate
// limiter. Both are mocked so the handler's own logic (validation, rate-limit
// handling, headers, availability) is exercised in isolation; the real service
// is pulled in via vi.importActual for the render smoke test at the end.
vi.mock('../services/board-render', () => ({
  RenderQueueSaturatedError: class RenderQueueSaturatedError extends Error {},
  ensureBoardRendererAvailable: vi.fn(async () => true),
  renderOgClimb: vi.fn(),
  initBoardRenderer: vi.fn(),
}));
vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(async () => {}),
}));

import { handleOgClimb } from '../handlers/og-climb';
import { RenderQueueSaturatedError, ensureBoardRendererAvailable, renderOgClimb } from '../services/board-render';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';

type MockRes = {
  statusCode: number;
  body: string | Buffer;
  headers: Record<string, unknown>;
  writeHead: (status: number, headers?: Record<string, unknown>) => void;
  end: (body?: string | Buffer) => void;
  setHeader: (name: string, value: unknown) => void;
};

function makeResponse(): MockRes {
  return {
    statusCode: 0,
    body: '',
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

function makeRequest(params: Record<string, string>, method = 'GET'): { req: IncomingMessage; url: URL } {
  const url = new URL('http://localhost:8080/og/climb');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const req = {
    method,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
  return { req, url };
}

const validParams = {
  board_name: 'kilter',
  layout_id: '1',
  size_id: '10',
  set_ids: '1,20',
  frames: 'p1080r15p1202r12',
};

async function run(params: Record<string, string>): Promise<MockRes> {
  const { req, url } = makeRequest(params);
  const res = makeResponse();
  await handleOgClimb(req, res as unknown as ServerResponse, url);
  return res;
}

describe('handleOgClimb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureBoardRendererAvailable).mockResolvedValue(true);
    vi.mocked(checkRateLimitRedis).mockResolvedValue(undefined);
    vi.mocked(renderOgClimb).mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
      contentType: 'image/jpeg',
      cache: 'miss',
      timings: { wasmMs: 12, baseMs: 8, encodeMs: 4 },
    });
  });

  describe('validation (before any render work)', () => {
    it('rejects an invalid board_name with 400 and never renders', async () => {
      const res = await run({ ...validParams, board_name: 'evil' });
      expect(res.statusCode).toBe(400);
      expect(renderOgClimb).not.toHaveBeenCalled();
    });

    it('rejects a missing board_name with 400', async () => {
      const { board_name: _omit, ...params } = validParams;
      const res = await run(params);
      expect(res.statusCode).toBe(400);
      expect(renderOgClimb).not.toHaveBeenCalled();
    });

    it('rejects non-numeric set_ids with 400', async () => {
      const res = await run({ ...validParams, set_ids: '1,a' });
      expect(res.statusCode).toBe(400);
      expect(renderOgClimb).not.toHaveBeenCalled();
    });

    it('rejects oversized set_ids before schema and render work', async () => {
      const res = await run({ ...validParams, set_ids: '1'.repeat(MAX_SET_IDS_LENGTH + 1) });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(String(res.body))).toEqual({
        error: 'Invalid parameters',
        details: ['set_ids is too large'],
      });
      expect(renderOgClimb).not.toHaveBeenCalled();
      expect(ensureBoardRendererAvailable).not.toHaveBeenCalled();
      expect(checkRateLimitRedis).not.toHaveBeenCalled();
    });

    it('rejects missing or empty frames with 400 — a blank board must not get immutable 200 headers', async () => {
      const { frames: _omit, ...paramsWithoutFrames } = validParams;
      const missingFramesResponse = await run(paramsWithoutFrames);
      expect(missingFramesResponse.statusCode).toBe(400);

      const emptyFramesResponse = await run({ ...validParams, frames: '' });
      expect(emptyFramesResponse.statusCode).toBe(400);
      expect(renderOgClimb).not.toHaveBeenCalled();
    });

    it('rejects malformed frames with 400', async () => {
      const res = await run({ ...validParams, frames: 'p1073r42<script>' });
      expect(res.statusCode).toBe(400);
      expect(renderOgClimb).not.toHaveBeenCalled();
    });

    it('rejects an unknown format with 400', async () => {
      const res = await run({ ...validParams, format: 'gif' });
      expect(res.statusCode).toBe(400);
      expect(renderOgClimb).not.toHaveBeenCalled();
    });

    it('rejects an invalid render_mode, glow_falloff, or field_color with 400', async () => {
      expect((await run({ ...validParams, render_mode: 'neon' })).statusCode).toBe(400);
      expect((await run({ ...validParams, glow_falloff: 'hard' })).statusCode).toBe(400);
      expect((await run({ ...validParams, field_color: 'blue' })).statusCode).toBe(400);
      expect(renderOgClimb).not.toHaveBeenCalled();
    });
  });

  describe('aura render options (issue #2202)', () => {
    it('draws Aura when the caller names no drawing, with the rest defaulted closed', async () => {
      // A bare URL is a crawler, an old store binary or a third-party embed —
      // they get the drawing the app ships, not the one frozen at the moment
      // their build went out. Boardsesh's own callers name it explicitly, so
      // their cards get their own Cloudflare entry.
      await run(validParams);
      const [callArgs] = vi.mocked(renderOgClimb).mock.calls[0];
      expect(callArgs.renderMode).toBe('aura');
      expect(callArgs.glowFalloff).toBe('soft');
      expect(callArgs.glyphs).toBe(false);
      expect(callArgs.fieldColor).toBeUndefined();
    });

    it('still serves the classic drawing when it is asked for by name', async () => {
      await run({ ...validParams, render_mode: 'classic' });
      expect(vi.mocked(renderOgClimb).mock.calls[0][0].renderMode).toBe('classic');
    });

    it('reaches the service with glow_falloff=plateau, without disturbing the drawing', async () => {
      await run({ ...validParams, glow_falloff: 'plateau' });
      const [callArgs] = vi.mocked(renderOgClimb).mock.calls[0];
      expect(callArgs.glowFalloff).toBe('plateau');
      // Naming one option must not knock the others off their defaults.
      expect(callArgs.renderMode).toBe('aura');
    });

    it('maps glyphs=1 to true and passes field_color through', async () => {
      await run({ ...validParams, render_mode: 'aura', glyphs: '1', field_color: '#123456' });
      const [callArgs] = vi.mocked(renderOgClimb).mock.calls[0];
      expect(callArgs.glyphs).toBe(true);
      expect(callArgs.fieldColor).toBe('#123456');
    });
  });

  describe('rate limiting', () => {
    it('returns 429 with Retry-After when the limiter throws, without rendering', async () => {
      vi.mocked(checkRateLimitRedis).mockRejectedValueOnce(new RateLimitError(30));
      const res = await run(validParams);
      expect(res.statusCode).toBe(429);
      expect(res.headers['Retry-After']).toBe('30');
      expect(res.headers['Content-Length']).toBe(Buffer.byteLength(String(res.body)));
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(renderOgClimb).not.toHaveBeenCalled();
    });
  });

  describe('availability', () => {
    it('returns 503 when the renderer is unavailable, without rendering', async () => {
      vi.mocked(ensureBoardRendererAvailable).mockResolvedValue(false);
      const res = await run(validParams);
      expect(res.statusCode).toBe(503);
      expect(renderOgClimb).not.toHaveBeenCalled();
    });
  });

  describe('rate-limit identity', () => {
    it('buckets headerless clients under "unknown" rather than skipping the limit', async () => {
      const url = new URL('http://localhost:8080/og/climb');
      for (const [key, value] of Object.entries(validParams)) {
        url.searchParams.set(key, value);
      }
      const req = { method: 'GET', headers: {}, socket: {} } as unknown as IncomingMessage;
      const res = makeResponse();
      await handleOgClimb(req, res as unknown as ServerResponse, url);
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(checkRateLimitRedis).mock.calls[0][0]).toBe('unknown');
    });

    it('prefers CF-Connecting-IP over the x-forwarded-for chain when Cloudflare fronts the host', async () => {
      const url = new URL('http://localhost:8080/og/climb');
      for (const [key, value] of Object.entries(validParams)) {
        url.searchParams.set(key, value);
      }
      const req = {
        method: 'GET',
        headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7, 172.68.1.1' },
        socket: { remoteAddress: '10.0.0.1' },
      } as unknown as IncomingMessage;
      const res = makeResponse();
      await handleOgClimb(req, res as unknown as ServerResponse, url);
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(checkRateLimitRedis).mock.calls[0][0]).toBe('203.0.113.7');
    });
  });

  describe('CORS preflight', () => {
    it('short-circuits OPTIONS before rate limiting and rendering', async () => {
      const { req, url } = makeRequest(validParams, 'OPTIONS');
      const res = makeResponse();
      await handleOgClimb(req, res as unknown as ServerResponse, url);
      expect(res.statusCode).toBe(200);
      expect(checkRateLimitRedis).not.toHaveBeenCalled();
      expect(renderOgClimb).not.toHaveBeenCalled();
    });
  });

  describe('success response', () => {
    it('sends 200 with immutable cache headers, Content-Length, and nosniff', async () => {
      const res = await run(validParams);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/jpeg');
      expect(String(res.headers['Cache-Control'])).toContain('immutable');
      expect(res.headers['Content-Length']).toBe(4);
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(String(res.headers['Server-Timing'])).toContain('cache;desc=miss');
    });

    it('defaults to JPEG when no format is given', async () => {
      await run(validParams);
      expect(vi.mocked(renderOgClimb).mock.calls[0][0].format).toBe('jpeg');
    });

    it('honours an explicit png format', async () => {
      await run({ ...validParams, format: 'png' });
      expect(vi.mocked(renderOgClimb).mock.calls[0][0].format).toBe('png');
    });

    it('surfaces a byte-cache hit in Server-Timing', async () => {
      vi.mocked(renderOgClimb).mockResolvedValueOnce({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        contentType: 'image/jpeg',
        cache: 'hit',
        timings: { wasmMs: 0, baseMs: 0, encodeMs: 0 },
      });
      const res = await run(validParams);
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['Server-Timing'])).toContain('cache;desc=hit');
    });

    it('returns 500 when the renderer throws', async () => {
      vi.mocked(renderOgClimb).mockRejectedValueOnce(new Error('boom'));
      const res = await run(validParams);
      expect(res.statusCode).toBe(500);
    });

    it('sheds a saturated render queue with retryable, non-cacheable 503', async () => {
      vi.mocked(renderOgClimb).mockRejectedValueOnce(new RenderQueueSaturatedError());
      const res = await run(validParams);
      expect(res.statusCode).toBe(503);
      expect(res.headers['Retry-After']).toBe('5');
      expect(res.headers['Cache-Control']).toBe('no-store');
    });
  });
});

// Real render path: resolves the WASM binary from the workspace and uses real
// sharp. Board photos come from packages/web/public if present; the render
// succeeds (backdrop-only) even when they are not.
describe('renderOgClimb (real render)', () => {
  it('renders a 1200x630 JPEG and serves an identical second request from the byte cache', async () => {
    process.env.BOARD_IMAGES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/public');
    const service = await vi.importActual<typeof import('../services/board-render')>('../services/board-render');

    await service.initBoardRenderer();
    expect(await service.ensureBoardRendererAvailable()).toBe(true);

    const params = {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      frames: 'p1080r15p1202r12',
      format: 'jpeg' as const,
    };

    const first = await service.renderOgClimb(params);
    expect(first.contentType).toBe('image/jpeg');
    // JPEG magic bytes.
    expect(first.buffer[0]).toBe(0xff);
    expect(first.buffer[1]).toBe(0xd8);
    expect(first.buffer[2]).toBe(0xff);

    const metadata = await sharp(first.buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);

    // Second identical request is a byte-cache hit — no WASM render runs.
    const second = await service.renderOgClimb(params);
    expect(second.cache).toBe('hit');
    expect(second.timings.wasmMs).toBe(0);
    expect(second.buffer).toBe(first.buffer);

    // Concurrent requests for the same uncached climb coalesce into a single
    // render: both callers resolve to the exact same result object.
    const uncachedParams = { ...params, frames: 'p1096r15p1234r12' };
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      service.renderOgClimb(uncachedParams),
      service.renderOgClimb(uncachedParams),
    ]);
    expect(concurrentSecond).toBe(concurrentFirst);

    // The canonical plain-board endpoint uses the same renderer and byte cache.
    // Empty frames are valid here (blank-board previews are a real caller), and
    // thumbnail/background/dim options are exercised through real WASM + sharp.
    const boardParams = {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      frames: '',
      format: 'webp' as const,
      thumbnail: true,
      includeBackground: true,
      dimBackground: 0.18,
      isOgVariant: false,
    };
    const boardFirst = await service.renderBoardImage(boardParams);
    expect(boardFirst.contentType).toBe('image/webp');
    const boardMetadata = await sharp(boardFirst.buffer).metadata();
    expect(boardMetadata.format).toBe('webp');
    expect(boardMetadata.width).toBe(200);
    const boardSecond = await service.renderBoardImage(boardParams);
    expect(boardSecond.cache).toBe('hit');
    expect(boardSecond.buffer).toBe(boardFirst.buffer);
  }, 30_000);

  // issue #2202: an aura render must never be served under a classic
  // byte-cache key. The board-photo base is independent of render options,
  // so switching modes must still reuse the base populated by the first call.
  it('keys the byte cache on render_mode/glow_falloff/glyphs/field_color', async () => {
    process.env.BOARD_IMAGES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/public');
    const service = await vi.importActual<typeof import('../services/board-render')>('../services/board-render');
    await service.initBoardRenderer();

    const baseParams = {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      // Frames unique to this test, so its byte-cache entries can't collide
      // with the earlier test's.
      frames: 'p1080r15p1202r44',
      format: 'jpeg' as const,
    };

    const classic = await service.renderOgClimb(baseParams);
    expect(classic.cache).not.toBe('hit');

    // Same board/frames/format, but aura mode — a byte-cache key
    // missing these params would have served the classic bytes here.
    const boardsesh = await service.renderOgClimb({
      ...baseParams,
      renderMode: 'aura' as const,
      glowFalloff: 'plateau' as const,
      glyphs: true,
      fieldColor: '#123456',
    });
    expect(boardsesh.cache).toBe('base-hit');

    // Repeating the exact boardsesh request IS a byte-cache hit — the key is
    // internally consistent, not just "always different".
    const boardseshRepeat = await service.renderOgClimb({
      ...baseParams,
      renderMode: 'aura' as const,
      glowFalloff: 'plateau' as const,
      glyphs: true,
      fieldColor: '#123456',
    });
    expect(boardseshRepeat.cache).toBe('hit');
  }, 30_000);
});
