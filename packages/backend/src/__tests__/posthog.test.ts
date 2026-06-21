import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { initCors } from '../handlers/cors';
import { handlePosthogProxy } from '../handlers/posthog';

type ProxyReq = Parameters<typeof handlePosthogProxy>[0];
type ProxyRes = Parameters<typeof handlePosthogProxy>[1];

type FakeReqOptions = {
  method: string;
  origin?: string;
  body?: string;
  bodyBytes?: Uint8Array;
  contentType?: string;
  contentEncoding?: string;
  forwardedFor?: string;
  remoteAddress?: string;
  userAgent?: string;
};

function createFakeReq(options: FakeReqOptions): ProxyReq {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const headers: Record<string, string> = {};
  if (options.origin) headers.origin = options.origin;
  if (options.contentType) headers['content-type'] = options.contentType;
  if (options.contentEncoding) headers['content-encoding'] = options.contentEncoding;
  if (options.forwardedFor) headers['x-forwarded-for'] = options.forwardedFor;
  if (options.userAgent) headers['user-agent'] = options.userAgent;

  const req = {
    method: options.method,
    headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    destroy: vi.fn(),
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
  };

  // Emit the body once the handler has attached listeners. Use Uint8Array
  // (a Web standard global) so we don't need to import Node's Buffer here —
  // the handler concats with Buffer.concat which accepts ArrayBufferView.
  queueMicrotask(() => {
    const bytes = options.bodyBytes ?? (options.body !== undefined ? new TextEncoder().encode(options.body) : null);
    if (bytes) {
      listeners.data?.forEach((cb) => cb(bytes));
    }
    listeners.end?.forEach((cb) => cb());
  });

  return req as unknown as ProxyReq;
}

type FakeRes = {
  status: number | null;
  headers: Record<string, string>;
  body: string | null;
  setHeader: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  headersSent: boolean;
  asProxyRes: ProxyRes;
};

function createFakeRes(): FakeRes {
  const captured: Partial<FakeRes> = { status: null, headers: {}, body: null, headersSent: false };
  const target = {
    setHeader: vi.fn((key: string, value: string) => {
      captured.headers![key] = value;
    }),
    writeHead: vi.fn((status: number, headerMap?: Record<string, string>) => {
      captured.status = status;
      if (headerMap) Object.assign(captured.headers!, headerMap);
      captured.headersSent = true;
    }),
    end: vi.fn((chunk?: unknown) => {
      if (typeof chunk === 'string') captured.body = chunk;
      else if (chunk instanceof Uint8Array) captured.body = new TextDecoder().decode(chunk);
    }),
    get headersSent() {
      return captured.headersSent ?? false;
    },
  };
  return {
    get status() {
      return captured.status ?? null;
    },
    get headers() {
      return captured.headers ?? {};
    },
    get body() {
      return captured.body ?? null;
    },
    get headersSent() {
      return captured.headersSent ?? false;
    },
    setHeader: target.setHeader,
    writeHead: target.writeHead,
    end: target.end,
    asProxyRes: target as unknown as ProxyRes,
  };
}

function buildUrl(pathname: string, search = ''): URL {
  return new URL(`http://localhost:8080${pathname}${search}`);
}

describe('PostHog Proxy Handler', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    initCors('https://boardsesh.com');
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('responds to OPTIONS preflight with CORS headers and no upstream call', async () => {
    const req = createFakeReq({ method: 'OPTIONS', origin: 'https://boardsesh.com' });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog/i/v0/e/'));

    expect(res.status).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://boardsesh.com');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods with 405', async () => {
    const req = createFakeReq({ method: 'GET', origin: 'https://boardsesh.com' });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog/i/v0/e/'));

    expect(res.status).toBe(405);
    expect(res.headers.Allow).toBe('POST, OPTIONS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a POST to PostHog with body, content-type, query string, and X-Forwarded-For', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"status":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const req = createFakeReq({
      method: 'POST',
      origin: 'https://boardsesh.com',
      body: '{"event":"test"}',
      contentType: 'application/json',
      forwardedFor: '203.0.113.7, 10.0.0.1',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog/batch/', '?ip=1'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const upstreamUrl = callArgs[0];
    const init = callArgs[1];
    expect(upstreamUrl).toBe('https://us.i.posthog.com/batch/?ip=1');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Forwarded-For']).toBe('203.0.113.7');
    // UA must reach PostHog so it isn't recorded with an empty user agent (→ bot).
    expect(headers['User-Agent']).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    );
    // Body must be forwarded as bytes (the SDK may have gzipped it).
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"event":"test"}');
    // No Content-Encoding when the request didn't have one.
    expect(headers['Content-Encoding']).toBeUndefined();

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(res.body).toBe('{"status":1}');
  });

  it('forwards Content-Encoding so upstream can decompress gzipped batch payloads', async () => {
    fetchMock.mockResolvedValue(new Response('1', { status: 200 }));

    // Simulate the binary blob the SDK builds via CompressionStream — the
    // bytes themselves don't need to be valid gzip; the handler just forwards
    // them along with the Content-Encoding header.
    const gzippedBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const req = createFakeReq({
      method: 'POST',
      origin: 'https://boardsesh.com',
      bodyBytes: gzippedBytes,
      contentType: 'application/json',
      contentEncoding: 'gzip',
    });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog/batch/'));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('gzip');
    expect(init.body).toBeInstanceOf(Uint8Array);
    const forwarded = init.body as Uint8Array;
    expect(Array.from(forwarded)).toEqual(Array.from(gzippedBytes));
  });

  it('falls back to socket.remoteAddress for X-Forwarded-For when header is absent', async () => {
    fetchMock.mockResolvedValue(new Response('1', { status: 200 }));

    const req = createFakeReq({
      method: 'POST',
      origin: 'https://boardsesh.com',
      body: '{}',
      remoteAddress: '198.51.100.4',
    });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog/i/v0/e/'));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Forwarded-For']).toBe('198.51.100.4');
  });

  it('omits User-Agent when the incoming request has none (avoids sending an empty UA)', async () => {
    fetchMock.mockResolvedValue(new Response('1', { status: 200 }));

    const req = createFakeReq({ method: 'POST', origin: 'https://boardsesh.com', body: '{}' });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog/i/v0/e/'));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBeUndefined();
  });

  it('returns 404 when the path is exactly the prefix (no upstream target)', async () => {
    const req = createFakeReq({ method: 'POST', origin: 'https://boardsesh.com', body: '{}' });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog'));

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 413 when the body exceeds 64KB', async () => {
    const oversized = 'a'.repeat(64 * 1024 + 1);
    const req = createFakeReq({
      method: 'POST',
      origin: 'https://boardsesh.com',
      body: oversized,
    });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog/i/v0/e/'));

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mirrors upstream non-2xx status and content-type back to the caller', async () => {
    fetchMock.mockResolvedValue(
      new Response('upstream blew up', { status: 503, headers: { 'content-type': 'text/plain' } }),
    );

    const req = createFakeReq({ method: 'POST', origin: 'https://boardsesh.com', body: '{}' });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog/i/v0/e/'));

    expect(res.status).toBe(503);
    expect(res.headers['Content-Type']).toBe('text/plain');
    expect(res.body).toBe('upstream blew up');
  });

  it('returns 502 when the upstream fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const req = createFakeReq({ method: 'POST', origin: 'https://boardsesh.com', body: '{}' });
    const res = createFakeRes();

    await handlePosthogProxy(req, res.asProxyRes, buildUrl('/api/posthog/i/v0/e/'));

    expect(res.status).toBe(502);
    const payload = JSON.parse(res.body ?? '{}') as { error?: string };
    expect(payload.error).toBe('Upstream unavailable');
  });
});
