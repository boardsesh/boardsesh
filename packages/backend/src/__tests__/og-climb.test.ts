import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { RateLimitError } from '../utils/rate-limiter';

// The handler under test talks to the board-render service and the Redis rate
// limiter. Both are mocked so the handler's own logic (validation, rate-limit
// handling, headers, availability) is exercised in isolation; the real service
// is pulled in via vi.importActual for the render smoke test at the end.
vi.mock('../services/board-render', () => ({
  isBoardRendererAvailable: vi.fn(() => true),
  renderOgClimb: vi.fn(),
  initBoardRenderer: vi.fn(),
}));
vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(async () => {}),
}));

import { handleOgClimb } from '../handlers/og-climb';
import { isBoardRendererAvailable, renderOgClimb } from '../services/board-render';
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
    vi.mocked(isBoardRendererAvailable).mockReturnValue(true);
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
  });

  describe('rate limiting', () => {
    it('returns 429 with Retry-After when the limiter throws, without rendering', async () => {
      vi.mocked(checkRateLimitRedis).mockRejectedValueOnce(new RateLimitError(30));
      const res = await run(validParams);
      expect(res.statusCode).toBe(429);
      expect(res.headers['Retry-After']).toBe('30');
      expect(renderOgClimb).not.toHaveBeenCalled();
    });
  });

  describe('availability', () => {
    it('returns 503 when the renderer is unavailable, without rendering', async () => {
      vi.mocked(isBoardRendererAvailable).mockReturnValue(false);
      const res = await run(validParams);
      expect(res.statusCode).toBe(503);
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
    expect(service.isBoardRendererAvailable()).toBe(true);

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
  }, 30_000);
});
