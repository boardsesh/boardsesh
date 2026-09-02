import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitError } from '../utils/rate-limiter';
import { MAX_SET_IDS_LENGTH } from '@boardsesh/board-render';

vi.mock('../services/board-render', () => ({
  InvalidBoardRenderConfigError: class InvalidBoardRenderConfigError extends Error {
    constructor() {
      super('Invalid board configuration');
    }
  },
  RenderOutputTooLargeError: class RenderOutputTooLargeError extends Error {},
  RenderQueueSaturatedError: class RenderQueueSaturatedError extends Error {},
  ensureBoardRendererAvailable: vi.fn(async () => true),
  renderBoardImage: vi.fn(),
}));
vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(async () => {}),
}));

import { handleBoardRender, isBoardRenderPath } from '../handlers/board-render';
import {
  InvalidBoardRenderConfigError,
  RenderOutputTooLargeError,
  RenderQueueSaturatedError,
  ensureBoardRendererAvailable,
  renderBoardImage,
} from '../services/board-render';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';

type MockResponse = {
  statusCode: number;
  body: string | Buffer;
  headers: Record<string, unknown>;
  writeHead: (status: number, headers?: Record<string, unknown>) => void;
  end: (body?: string | Buffer) => void;
  setHeader: (name: string, value: unknown) => void;
};

function makeResponse(): MockResponse {
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

const validParams = {
  board_name: 'kilter',
  layout_id: '1',
  size_id: '10',
  set_ids: '1,20',
  frames: 'p1080r15p1202r12',
};

function makeRequest(params: Record<string, string>, method = 'GET'): { req: IncomingMessage; url: URL } {
  const url = new URL('http://localhost:8080/render/board');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return {
    req: { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage,
    url,
  };
}

async function run(params: Record<string, string>, method = 'GET'): Promise<MockResponse> {
  const { req, url } = makeRequest(params, method);
  const res = makeResponse();
  await handleBoardRender(req, res as unknown as ServerResponse, url);
  return res;
}

describe('handleBoardRender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureBoardRendererAvailable).mockResolvedValue(true);
    vi.mocked(checkRateLimitRedis).mockResolvedValue(undefined);
    vi.mocked(renderBoardImage).mockResolvedValue({
      buffer: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      contentType: 'image/webp',
      cache: 'miss',
      timings: { wasmMs: 4, baseMs: 0, sharpMs: 3, composeMs: 2, encodeMs: 1, bgMs: 0 },
      queueMs: 0,
    });
  });

  it('preserves the default webp contract and accepts an empty frames string', async () => {
    const response = await run({ ...validParams, frames: '' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('image/webp');
    expect(vi.mocked(renderBoardImage).mock.calls[0][0]).toMatchObject({
      frames: '',
      format: 'webp',
      thumbnail: false,
      includeBackground: false,
      dimBackground: 0,
      isOgVariant: false,
      renderMode: 'aura',
      glowFalloff: 'soft',
      glyphs: false,
      colorScheme: 'light',
    });
    expect(checkRateLimitRedis).toHaveBeenCalledTimes(2);
    expect(checkRateLimitRedis).toHaveBeenNthCalledWith(1, '127.0.0.1', 'board-render', 120, 60_000);
    expect(checkRateLimitRedis).toHaveBeenNthCalledWith(2, '127.0.0.1', 'board-render-peer', 600, 60_000);
  });

  it('validates and passes render-mode and color-scheme options through', async () => {
    await run({
      ...validParams,
      render_mode: 'aura',
      glow_falloff: 'plateau',
      glyphs: '1',
      field_color: '#123456',
      color_scheme: 'dark',
    });

    expect(vi.mocked(renderBoardImage).mock.calls[0][0]).toMatchObject({
      renderMode: 'aura',
      glowFalloff: 'plateau',
      glyphs: true,
      fieldColor: '#123456',
      colorScheme: 'dark',
    });

    vi.mocked(renderBoardImage).mockClear();
    expect((await run({ ...validParams, render_mode: 'neon' })).statusCode).toBe(400);
    expect((await run({ ...validParams, color_scheme: 'sepia' })).statusCode).toBe(400);
    expect(renderBoardImage).not.toHaveBeenCalled();
  });

  it('passes thumbnail, background, dim, OG, and format flags through', async () => {
    await run({
      ...validParams,
      thumbnail: '1',
      include_background: '1',
      dim_background: '0.18',
      variant: 'og',
      format: 'jpg',
    });
    expect(vi.mocked(renderBoardImage).mock.calls[0][0]).toMatchObject({
      thumbnail: true,
      includeBackground: true,
      dimBackground: 0.18,
      isOgVariant: true,
      format: 'jpeg',
    });
  });

  it('rejects malformed required fields, frames, formats, and dim before rendering', async () => {
    expect((await run({ ...validParams, board_name: 'unknown' })).statusCode).toBe(400);
    expect((await run({ ...validParams, frames: 'p1r15<script>' })).statusCode).toBe(400);
    expect((await run({ ...validParams, format: 'gif' })).statusCode).toBe(400);
    expect((await run({ ...validParams, dim_background: '1.1' })).statusCode).toBe(400);
    const { set_ids: _setIds, ...missingSetIds } = validParams;
    expect((await run(missingSetIds)).statusCode).toBe(400);
    expect(renderBoardImage).not.toHaveBeenCalled();
    expect(ensureBoardRendererAvailable).not.toHaveBeenCalled();
  });

  it('strictly validates board geometry and set ids before checking renderer availability', async () => {
    const invalidQueries = [
      { ...validParams, layout_id: '-1' },
      { ...validParams, layout_id: '1.5' },
      { ...validParams, layout_id: '9007199254740992' },
      { ...validParams, size_id: 'nope' },
      { ...validParams, set_ids: '1,,20' },
      { ...validParams, set_ids: '1,a' },
      { ...validParams, set_ids: '999999999999999999999999' },
      { ...validParams, set_ids: '1'.repeat(MAX_SET_IDS_LENGTH + 1) },
      { ...validParams, set_ids: '1,2,3,4,5,6,7,8,9,10,11' },
    ];

    for (const query of invalidQueries) {
      expect((await run(query)).statusCode).toBe(400);
    }
    expect(ensureBoardRendererAvailable).not.toHaveBeenCalled();
    expect(renderBoardImage).not.toHaveBeenCalled();
  });

  it('uses immutable headers only for well-formed versions', async () => {
    const versioned = await run({ ...validParams, v: '0123456789ab' });
    expect(String(versioned.headers['Cache-Control'])).toContain('immutable');
    expect(versioned.headers['Vercel-CDN-Cache-Control']).toBeUndefined();

    const malformed = await run({ ...validParams, v: 'not-a-version' });
    expect(String(malformed.headers['Cache-Control'])).toContain('s-maxage=86400');
    expect(String(malformed.headers['Cache-Control'])).not.toContain('immutable');
  });

  it('keeps v at the handler/cache-header layer and out of pixel-render parameters', async () => {
    await run({ ...validParams, v: '0123456789ab' });
    const versionedRenderParams = vi.mocked(renderBoardImage).mock.calls[0][0];
    vi.mocked(renderBoardImage).mockClear();
    await run({ ...validParams, v: 'abcdef012345' });
    const nextVersionRenderParams = vi.mocked(renderBoardImage).mock.calls[0][0];

    expect(nextVersionRenderParams).toEqual(versionedRenderParams);
    expect(versionedRenderParams).not.toHaveProperty('v');
  });

  it('supports HEAD with GET-equivalent headers and no response bytes', async () => {
    const response = await run(validParams, 'HEAD');
    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Length']).toBe(4);
    expect(response.body).toBe('');
    expect(renderBoardImage).toHaveBeenCalledOnce();
  });

  it('answers credentialless wildcard OPTIONS without initialising or rendering', async () => {
    const response = await run({}, 'OPTIONS');
    expect(response.statusCode).toBe(200);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(response.headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(ensureBoardRendererAvailable).not.toHaveBeenCalled();
    expect(checkRateLimitRedis).not.toHaveBeenCalled();
    expect(renderBoardImage).not.toHaveBeenCalled();
  });

  it('rate-limits by client before renderer work', async () => {
    vi.mocked(checkRateLimitRedis).mockRejectedValueOnce(new RateLimitError(23));

    const response = await run(validParams);

    expect(response.statusCode).toBe(429);
    expect(response.headers['Retry-After']).toBe('23');
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(ensureBoardRendererAvailable).not.toHaveBeenCalled();
    expect(renderBoardImage).not.toHaveBeenCalled();
  });

  it('rate-limits by socket peer before renderer work', async () => {
    vi.mocked(checkRateLimitRedis).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new RateLimitError(17));

    const response = await run(validParams);

    expect(response.statusCode).toBe(429);
    expect(response.headers['Retry-After']).toBe('17');
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(checkRateLimitRedis).toHaveBeenCalledTimes(2);
    expect(ensureBoardRendererAvailable).not.toHaveBeenCalled();
    expect(renderBoardImage).not.toHaveBeenCalled();
  });

  it('returns retryable no-store 503 when the shared queue is saturated', async () => {
    vi.mocked(renderBoardImage).mockRejectedValueOnce(new RenderQueueSaturatedError());
    const response = await run(validParams);
    expect(response.statusCode).toBe(503);
    expect(response.headers['Retry-After']).toBe('5');
    expect(response.headers['Cache-Control']).toBe('no-store');
  });

  it('maps the service pixel ceiling to the legacy 400 status', async () => {
    vi.mocked(renderBoardImage).mockRejectedValueOnce(new RenderOutputTooLargeError(2_000, 2_000));
    const response = await run(validParams);
    expect(response.statusCode).toBe(400);
  });

  it('maps invalid catalog geometry to a generic 400', async () => {
    vi.mocked(renderBoardImage).mockRejectedValueOnce(new InvalidBoardRenderConfigError());
    const response = await run({ ...validParams, size_id: '999' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(String(response.body))).toEqual({ error: 'Invalid board configuration' });
  });

  it('logs unexpected failures without returning internal details', async () => {
    vi.mocked(renderBoardImage).mockRejectedValueOnce(new Error('/srv/private/board-image.webp missing'));
    const response = await run(validParams);
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(String(response.body))).toEqual({ error: 'Render failed' });
    expect(String(response.body)).not.toContain('/srv/private');
  });
});

describe('board render route aliases', () => {
  it('routes the canonical and legacy paths to the same handler surface', () => {
    expect(isBoardRenderPath('/render/board')).toBe(true);
    expect(isBoardRenderPath('/api/internal/board-render')).toBe(true);
    expect(isBoardRenderPath('/render/board/extra')).toBe(false);
  });
});
