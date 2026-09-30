import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { Plugin } from 'graphql-yoga';
import {
  MIN_COMPRESSIBLE_BYTES,
  negotiateResponseEncoding,
  responseCompressionPlugin,
} from '../graphql/response-compression';

type OnResponsePayload = Parameters<NonNullable<Plugin['onResponse']>>[0];

describe('negotiateResponseEncoding', () => {
  it.each([
    [null, null],
    ['', null],
    ['   ', null],
    ['identity', null],
    ['identity;q=0', null],
    ['*', 'br'],
    ['*;q=0', null],
    ['*, br;q=0', 'gzip'],
    ['*;q=0, gzip', 'gzip'],
    ['GZIP', 'gzip'],
    ['gzip ; q=0.5 , br ; q=0.4', 'gzip'],
    ['x-gzip', 'gzip'],
    ['gzip;q=0, x-gzip', null],
    ['br;q=nonsense, gzip', 'gzip'],
    ['gzip, gzip;q=0', null],
    ['gzip;q=0, gzip', 'gzip'],
    ['deflate', null],
    ['zstd, br', 'br'],
  ])('%j -> %s', (header, expected) => {
    expect(negotiateResponseEncoding(header)).toBe(expected);
  });
});

describe('responseCompressionPlugin', () => {
  const largeJson = JSON.stringify({ data: { items: Array.from({ length: 200 }, (_, index) => ({ index })) } });

  async function run(response: Response, acceptEncoding = 'gzip'): Promise<Response> {
    const plugin = responseCompressionPlugin();
    let result = response;
    await plugin.onResponse?.({
      request: new Request('http://localhost/graphql', { headers: { 'accept-encoding': acceptEncoding } }),
      response,
      serverContext: {},
      setResponse(next: Response) {
        result = next;
      },
      fetchAPI: globalThis,
    } as unknown as OnResponsePayload);
    return result;
  }

  it('merges Accept-Encoding into an existing Vary instead of replacing it', async () => {
    const response = await run(
      new Response(largeJson, { headers: { 'content-type': 'application/json', vary: 'Origin' } }),
    );
    expect(largeJson.length).toBeGreaterThan(MIN_COMPRESSIBLE_BYTES);
    expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')).toBe(largeJson);
  });

  it('does not duplicate Accept-Encoding in Vary', async () => {
    const response = await run(
      new Response(largeJson, { headers: { 'content-type': 'application/json', vary: 'accept-encoding' } }),
    );
    expect(response.headers.get('vary')).toBe('accept-encoding');
  });

  it('keeps the status and error body of a non-2xx JSON response', async () => {
    const response = await run(
      new Response(largeJson, { status: 400, headers: { 'content-type': 'application/graphql-response+json' } }),
    );
    expect(response.status).toBe(400);
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')).toBe(largeJson);
  });

  it('leaves an already-encoded response alone', async () => {
    const original = new Response(largeJson, {
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });
    expect(await run(original)).toBe(original);
  });

  it.each(['text/event-stream', 'multipart/mixed; boundary="-"', 'text/html'])(
    'never touches a %s response, so streams are not buffered',
    async (contentType) => {
      const stream = new ReadableStream({ start() {} }); // never closes, like a live SSE stream
      const original = new Response(stream, { headers: { 'content-type': contentType } });
      expect(await run(original)).toBe(original);
      expect(original.bodyUsed).toBe(false);
    },
  );
});
