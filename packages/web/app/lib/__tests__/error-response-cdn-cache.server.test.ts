// @vitest-environment node
import { MARKETING_CACHE_CONTROL, MARKETING_CDN_CACHE_CONTROL } from '../marketing-page-cache';
import { createServer, request, ServerResponse, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE,
  installErrorResponseCdnCacheGuard,
  isErrorStatus,
  withdrawSharedCacheHeaders,
} from '../error-response-cdn-cache.server';

// What the middleware stamps on a list or climb-view URL before the page renders.
const LIST_PAGE_CDN_CACHE = 's-maxage=86400, stale-while-revalidate=604800';
// What Next writes itself on a 404 or an error render.
const NEXT_ERROR_CACHE_CONTROL = 'private, no-cache, no-store, max-age=0, must-revalidate';

type ResponseWriter = (response: ServerResponse) => void;

// A subclass per test, so the guard never touches the real ServerResponse
// prototype other test files in this worker share.
function startServer(writeResponse: ResponseWriter): Promise<Server> {
  class GuardedResponse extends ServerResponse {}
  installErrorResponseCdnCacheGuard(GuardedResponse);
  const server = createServer({ ServerResponse: GuardedResponse }, (_incoming, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    writeResponse(response);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function fetchResponse(
  server: Server,
  method: 'GET' | 'HEAD' = 'GET',
  requestOptions: { path?: string; headers?: IncomingHttpHeaders; method?: string } = {},
): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: string }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, method, path: '/apps/kilter', ...requestOptions }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => (body += chunk));
      incoming.on('end', () => resolve({ statusCode: incoming.statusCode ?? 0, headers: incoming.headers, body }));
    })
      .on('error', reject)
      .end();
  });
}

// Next's own path: middleware headers via setHeader, then a status, then the body.
function nextStyleResponse(statusCode: number): ResponseWriter {
  return (response) => {
    response.setHeader('CDN-Cache-Control', LIST_PAGE_CDN_CACHE);
    response.setHeader('Vercel-CDN-Cache-Control', LIST_PAGE_CDN_CACHE);
    response.setHeader('Cache-Control', NEXT_ERROR_CACHE_CONTROL);
    response.statusCode = statusCode;
    response.end('<html>404: This page could not be found</html>');
  };
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe('installErrorResponseCdnCacheGuard', () => {
  it.each([404, 410, 500, 503])('turns the middleware TTL into no-store on a %i', async (statusCode) => {
    server = await startServer(nextStyleResponse(statusCode));
    const { statusCode: received, headers } = await fetchResponse(server);
    expect(received).toBe(statusCode);
    expect(headers['cdn-cache-control']).toBe(ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE);
    expect(headers['vercel-cdn-cache-control']).toBe(ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE);
    // Next's own Cache-Control is left as Next wrote it.
    expect(headers['cache-control']).toBe(NEXT_ERROR_CACHE_CONTROL);
  });

  it('keeps the TTL on a 200', async () => {
    server = await startServer(nextStyleResponse(200));
    const { headers } = await fetchResponse(server);
    expect(headers['cdn-cache-control']).toBe(LIST_PAGE_CDN_CACHE);
    expect(headers['vercel-cdn-cache-control']).toBe(LIST_PAGE_CDN_CACHE);
  });

  it('keeps the TTL on a redirect, which the climb-view legacy 308 relies on', async () => {
    server = await startServer((response) => {
      response.setHeader('CDN-Cache-Control', LIST_PAGE_CDN_CACHE);
      response.setHeader('Location', '/b/kilter-original-12x12/40/view/abc');
      response.statusCode = 308;
      response.end();
    });
    const { statusCode, headers } = await fetchResponse(server);
    expect(statusCode).toBe(308);
    expect(headers['cdn-cache-control']).toBe(LIST_PAGE_CDN_CACHE);
  });

  it('rewrites headers sent implicitly on the first write', async () => {
    server = await startServer((response) => {
      response.setHeader('CDN-Cache-Control', LIST_PAGE_CDN_CACHE);
      response.statusCode = 500;
      response.write('<html>');
      response.end('</html>');
    });
    const { headers } = await fetchResponse(server);
    expect(headers['cdn-cache-control']).toBe(ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE);
  });

  it('rewrites the headers of a HEAD request, which sends no body', async () => {
    server = await startServer(nextStyleResponse(404));
    const { statusCode, headers, body } = await fetchResponse(server, 'HEAD');
    expect(statusCode).toBe(404);
    expect(body).toBe('');
    expect(headers['cdn-cache-control']).toBe(ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE);
    expect(headers['vercel-cdn-cache-control']).toBe(ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE);
  });

  it('adds no shared-cache header to an error that never had one', async () => {
    server = await startServer((response) => {
      response.statusCode = 404;
      response.end();
    });
    const { headers } = await fetchResponse(server);
    expect(headers['cdn-cache-control']).toBeUndefined();
    expect(headers['vercel-cdn-cache-control']).toBeUndefined();
    expect(headers['cloudflare-cdn-cache-control']).toBeUndefined();
  });

  it('rewrites headers passed to writeHead as an object', async () => {
    server = await startServer((response) => {
      response.writeHead(503, { 'Cloudflare-CDN-Cache-Control': 's-maxage=60', 'X-Kept': 'yes' });
      response.end();
    });
    const { headers } = await fetchResponse(server);
    expect(headers['cloudflare-cdn-cache-control']).toBe(ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE);
    expect(headers['x-kept']).toBe('yes');
  });

  it('rewrites headers passed to writeHead as a flat array, with a reason phrase', async () => {
    server = await startServer((response) => {
      response.setHeader('Vercel-CDN-Cache-Control', LIST_PAGE_CDN_CACHE);
      response.writeHead(404, 'Not Found', ['CDN-Cache-Control', 's-maxage=60', 'X-Kept', 'yes']);
      response.end();
    });
    const { headers } = await fetchResponse(server);
    expect(headers['cdn-cache-control']).toBe(ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE);
    expect(headers['vercel-cdn-cache-control']).toBe(ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE);
    expect(headers['x-kept']).toBe('yes');
  });

  it('wraps a prototype only once', () => {
    class GuardedResponse extends ServerResponse {}
    expect(installErrorResponseCdnCacheGuard(GuardedResponse)).toBe(true);
    const ownWriteHead = (): unknown => Object.getOwnPropertyDescriptor(GuardedResponse.prototype, 'writeHead')?.value;
    const guardedWriteHead = ownWriteHead();
    expect(guardedWriteHead).toBeTypeOf('function');
    expect(installErrorResponseCdnCacheGuard(GuardedResponse)).toBe(false);
    expect(ownWriteHead()).toBe(guardedWriteHead);
  });
});

describe('withdrawSharedCacheHeaders', () => {
  it('rewrites only the shared-cache headers that are present', () => {
    const stored = new Map<string, string>([
      ['cdn-cache-control', LIST_PAGE_CDN_CACHE],
      ['cache-control', NEXT_ERROR_CACHE_CONTROL],
    ]);
    withdrawSharedCacheHeaders({
      getHeader: (headerName: string) => stored.get(headerName),
      setHeader(headerName: string, headerValue: string | number | readonly string[]) {
        stored.set(headerName, String(headerValue));
        return this as unknown as ServerResponse;
      },
    });
    expect(Object.fromEntries(stored)).toEqual({
      'cdn-cache-control': ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE,
      'cache-control': NEXT_ERROR_CACHE_CONTROL,
    });
  });
});

describe('isErrorStatus', () => {
  it.each([
    [200, false],
    [308, false],
    [399, false],
    [400, true],
    [404, true],
    [599, true],
  ])('%i is an error: %s', (statusCode, expected) => {
    expect(isErrorStatus(statusCode)).toBe(expected);
  });
});

describe('marketing final-response cache guard', () => {
  it.each([200, 307, 308, 404, 500])(
    'only caches successful cookie-free marketing responses: %i',
    async (statusCode) => {
      server = await startServer((response) => {
        response.setHeader('Cache-Control', MARKETING_CACHE_CONTROL);
        response.setHeader('CDN-Cache-Control', MARKETING_CDN_CACHE_CONTROL);
        response.statusCode = statusCode;
        response.end();
      });
      const { headers } = await fetchResponse(server);
      expect(headers['cache-control']).toBe(statusCode === 200 ? MARKETING_CACHE_CONTROL : 'no-store');
      expect(headers['cdn-cache-control']).toBe(statusCode === 200 ? MARKETING_CDN_CACHE_CONTROL : 'no-store');
    },
  );
  it('revokes a marketing response that sets a cookie', async () => {
    server = await startServer((response) => {
      response.setHeader('Cache-Control', MARKETING_CACHE_CONTROL);
      response.setHeader('CDN-Cache-Control', MARKETING_CDN_CACHE_CONTROL);
      response.setHeader('Set-Cookie', 'session=private; HttpOnly');
      response.end();
    });
    const { headers } = await fetchResponse(server);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['cdn-cache-control']).toBe('no-store');
    expect(headers['set-cookie']).toEqual(['session=private; HttpOnly']);
  });
  it('still revokes CDN caching after Next overwrites ordinary Cache-Control', async () => {
    server = await startServer((response) => {
      response.setHeader('Cache-Control', NEXT_ERROR_CACHE_CONTROL);
      response.setHeader('CDN-Cache-Control', MARKETING_CDN_CACHE_CONTROL);
      response.setHeader('Set-Cookie', 'private=yes');
      response.end();
    });
    const { headers } = await fetchResponse(server);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['cdn-cache-control']).toBe('no-store');
  });
  it.each(['object', 'array'])('guards marketing headers passed directly to writeHead as %s', async (form) => {
    server = await startServer((response) => {
      const headers = {
        'Cache-Control': MARKETING_CACHE_CONTROL,
        'CDN-Cache-Control': MARKETING_CDN_CACHE_CONTROL,
        'Set-Cookie': 'private=yes',
      };
      if (form === 'object') response.writeHead(200, headers);
      else response.writeHead(200, Object.entries(headers).flat());
      response.end();
    });
    const { headers } = await fetchResponse(server);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['cdn-cache-control']).toBe('no-store');
  });
});

describe('marketing document eligibility at the final write', () => {
  it.each(['text/x-component', 'application/json', undefined])(
    'revokes caching for content type %s',
    async (contentType) => {
      server = await startServer((response) => {
        response.setHeader('Cache-Control', MARKETING_CACHE_CONTROL);
        response.setHeader('CDN-Cache-Control', MARKETING_CDN_CACHE_CONTROL);
        if (contentType) response.setHeader('Content-Type', contentType);
        else response.removeHeader('Content-Type');
        response.end();
      });
      const { headers } = await fetchResponse(server);
      expect(headers['cache-control']).toBe('no-store');
      expect(headers['cdn-cache-control']).toBe('no-store');
    },
  );

  it.each(['object', 'array'])('uses the final content type supplied to writeHead as %s', async (form) => {
    server = await startServer((response) => {
      response.setHeader('Cache-Control', MARKETING_CACHE_CONTROL);
      response.setHeader('CDN-Cache-Control', MARKETING_CDN_CACHE_CONTROL);
      if (form === 'object') response.writeHead(200, { 'Content-Type': 'text/x-component' });
      else response.writeHead(200, ['Content-Type', 'text/x-component']);
      response.end();
    });
    const { headers } = await fetchResponse(server);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['cdn-cache-control']).toBe('no-store');
  });

  it.each<{ path?: string; headers?: IncomingHttpHeaders; method?: string }>([
    { headers: { rsc: '1' } },
    { headers: { 'next-router-prefetch': '1' } },
    { path: '/apps/kilter?_rsc=flight' },
    { headers: { authorization: 'Bearer credential' } },
    { headers: { cookie: '__Secure-boardsesh.session_token=credential' } },
    { path: '/', headers: { cookie: 'boardsesh-locale=fr' } },
    { path: '/account' },
    { path: '//' },
    { method: 'POST' },
  ])('revokes caching when the original request is ineligible: %j', async (requestOptions) => {
    server = await startServer((response) => {
      response.setHeader('Cache-Control', MARKETING_CACHE_CONTROL);
      response.setHeader('CDN-Cache-Control', MARKETING_CDN_CACHE_CONTROL);
      response.end('<html>document</html>');
    });
    const { headers } = await fetchResponse(server, 'GET', requestOptions);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['cdn-cache-control']).toBe('no-store');
  });
});

describe('marketing final Vary preservation', () => {
  it.each(['implicit', 'object', 'array'])(
    'merges protections with final Next fields through %s headers',
    async (form) => {
      server = await startServer((response) => {
        response.setHeader('CDN-Cache-Control', MARKETING_CDN_CACHE_CONTROL);
        response.setHeader('Vary', 'rsc, Accept-Encoding');
        if (form === 'object') response.writeHead(200, { Vary: 'Next-Router-State-Tree, X-Custom' });
        else if (form === 'array') response.writeHead(200, ['vArY', 'Next-Router-State-Tree, X-Custom']);
        response.end();
      });
      const { headers } = await fetchResponse(server);
      const fields = new Set(
        headers.vary
          ?.toLowerCase()
          .split(',')
          .map((field) => field.trim()),
      );
      expect(fields).toContain('cookie');
      expect(fields).toContain('authorization');
      expect(fields).toContain('rsc');
      expect(fields).toContain('accept-encoding');
      expect(fields).toContain('next-router-state-tree');
      expect(fields).toContain('next-router-prefetch');
      expect(fields).toContain('next-router-segment-prefetch');
      if (form !== 'implicit') expect(fields).toContain('x-custom');
    },
  );
  it('preserves Vary wildcard semantics', async () => {
    server = await startServer((response) => {
      response.setHeader('CDN-Cache-Control', MARKETING_CDN_CACHE_CONTROL);
      response.setHeader('Vary', '*');
      response.end();
    });
    const { headers } = await fetchResponse(server);
    expect(headers.vary).toBe('*');
  });
  it('leaves the Vary of existing board responses unchanged', async () => {
    server = await startServer((response) => {
      response.setHeader('CDN-Cache-Control', LIST_PAGE_CDN_CACHE);
      response.setHeader('Vary', 'Accept-Encoding');
      response.end();
    });
    const { headers } = await fetchResponse(server);
    expect(headers.vary).toBe('Accept-Encoding');
  });
});
