import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import type { Plugin } from 'graphql-yoga';

/**
 * Compresses `/graphql` JSON responses at the origin.
 *
 * Cloudflare compresses to the client either way, but Railway bills the bytes
 * that leave the container, and those were going out uncompressed (~440 GB a
 * month). `@whatwg-node/server`'s `useContentEncoding` was not used because it
 * splits `Accept-Encoding` on `,` without trimming or reading q-values, so
 * `br;q=1.0, gzip;q=0.8` got no compression at all and `identity, gzip` got none
 * either. It also compresses tiny bodies and omits `Vary: Accept-Encoding`.
 */

type ResponseEncoding = 'br' | 'gzip';

/** Below this, the encoding headers and CPU cost more than the bytes saved. */
export const MIN_COMPRESSIBLE_BYTES = 1024;

const COMPRESSIBLE_CONTENT_TYPES = new Set(['application/json', 'application/graphql-response+json']);

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/**
 * Picks the best encoding the client accepts, honouring q-values (`q=0` means
 * refused, `*` covers encodings not named). Brotli wins a tie.
 */
export function negotiateResponseEncoding(acceptEncoding: string | null): ResponseEncoding | null {
  if (!acceptEncoding) return null;
  const weights = new Map<string, number>();
  for (const entry of acceptEncoding.split(',')) {
    const [rawName = '', ...params] = entry.split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let weight = 1;
    for (const param of params) {
      const [key = '', rawWeight = ''] = param.split('=');
      if (key.trim().toLowerCase() !== 'q') continue;
      const parsedWeight = Number(rawWeight.trim());
      weight = Number.isFinite(parsedWeight) ? parsedWeight : 0;
    }
    weights.set(name, weight);
  }
  const wildcardWeight = weights.get('*') ?? 0;
  const brotliWeight = weights.get('br') ?? wildcardWeight;
  const gzipWeight = weights.get('gzip') ?? weights.get('x-gzip') ?? wildcardWeight;
  if (brotliWeight <= 0 && gzipWeight <= 0) return null;
  return brotliWeight >= gzipWeight ? 'br' : 'gzip';
}

function isCompressibleContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase();
  return mediaType !== undefined && COMPRESSIBLE_CONTENT_TYPES.has(mediaType);
}

function compress(body: Uint8Array, encoding: ResponseEncoding): Promise<Buffer> {
  if (encoding === 'gzip') return gzipAsync(body);
  // Quality 5 costs about what gzip -6 does and comes out ~4% smaller on
  // climb-list JSON; the default (11) is meant for static assets.
  return brotliAsync(body, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
    },
  });
}

function addVaryAcceptEncoding(headers: Headers): void {
  const vary = headers.get('vary');
  if (!vary) {
    headers.set('vary', 'Accept-Encoding');
    return;
  }
  const varyFields = vary.split(',').map((field) => field.trim().toLowerCase());
  if (!varyFields.includes('accept-encoding') && !varyFields.includes('*')) {
    headers.set('vary', `${vary}, Accept-Encoding`);
  }
}

export function responseCompressionPlugin(): Plugin {
  return {
    async onResponse(payload) {
      const { request, response, fetchAPI } = payload;
      if (!response.body || response.headers.has('content-encoding')) return;
      if (!isCompressibleContentType(response.headers.get('content-type'))) return;

      // Every JSON response here depends on Accept-Encoding, identity ones included.
      const headers = new fetchAPI.Headers(response.headers);
      addVaryAcceptEncoding(headers);

      const encoding = negotiateResponseEncoding(request.headers.get('accept-encoding'));
      // JSON responses are fully built before this hook runs, so buffering adds no latency.
      const body = new Uint8Array(await response.arrayBuffer());
      let outgoingBody = body;
      if (encoding && body.length >= MIN_COMPRESSIBLE_BYTES) {
        // Copy into an ArrayBuffer-backed view: fetch's BodyInit rejects zlib's ArrayBufferLike Buffer.
        outgoingBody = new Uint8Array(await compress(body, encoding));
        headers.set('content-encoding', encoding);
        headers.delete('content-length');
      }

      payload.setResponse(
        new fetchAPI.Response(outgoingBody, {
          status: response.status,
          statusText: response.statusText,
          headers,
        }),
      );
    },
  };
}
