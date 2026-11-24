// Server code (node:http), but without `import 'server-only'`: `instrumentation.ts`
// installs this at boot, outside the React server layer that package needs.
import {
  isCacheableMarketingRequest,
  MARKETING_CACHE_CONTROL,
  MARKETING_CACHE_VARY,
  MARKETING_CDN_CACHE_CONTROL,
} from './marketing-page-cache';
import { ServerResponse, type OutgoingHttpHeader, type OutgoingHttpHeaders } from 'node:http';

/**
 * The headers a shared cache reads ahead of `Cache-Control`, lower-cased the way
 * Node stores them. Cloudflare ranks `Cloudflare-CDN-Cache-Control` over
 * `CDN-Cache-Control` over `Cache-Control`. `Vercel-CDN-Cache-Control` is
 * Vercel's copy, which the middleware still writes.
 */
export const SHARED_CACHE_HEADERS = [
  'cloudflare-cdn-cache-control',
  'cdn-cache-control',
  'vercel-cdn-cache-control',
] as const;

const SHARED_CACHE_HEADER_SET: ReadonlySet<string> = new Set(SHARED_CACHE_HEADERS);

/** What an error response tells a shared cache in place of the TTL it was given. */
export const ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE = 'no-store';

/**
 * Marks a prototype as already guarded. `Symbol.for` so a second copy of this
 * module (another bundle, a dev reload) sees the same marker and does not wrap
 * `writeHead` twice.
 */
const GUARD_INSTALLED = Symbol.for('boardsesh.errorResponseCdnCacheGuard');

type HeadersArgument = OutgoingHttpHeaders | OutgoingHttpHeader[];

export function isErrorStatus(statusCode: number): boolean {
  return statusCode >= 400;
}

/**
 * Rewrites every shared-cache header already set on the response to `no-store`.
 * Headers that are absent stay absent: the guard only takes back a TTL someone
 * gave, it does not add cache policy to responses that never had one.
 */
export function withdrawSharedCacheHeaders(
  response: Pick<ServerResponse, 'getHeader' | 'setHeader'>,
  includeCacheControl = false,
): void {
  for (const headerName of includeCacheControl ? [...SHARED_CACHE_HEADERS, 'cache-control'] : SHARED_CACHE_HEADERS) {
    if (response.getHeader(headerName) !== undefined) {
      response.setHeader(headerName, ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE);
    }
  }
}

/**
 * The same rewrite for headers handed straight to `writeHead`, in either form
 * Node accepts: an object, or the flat `[name, value, name, value]` array.
 * Neither Next nor the middleware writes headers this way today; covering it
 * keeps the guard from depending on that.
 */
function withdrawSharedCacheFromHeadersArgument(
  headers: HeadersArgument,
  includeCacheControl: boolean,
): HeadersArgument {
  const shouldWithdraw = (headerName: string) =>
    SHARED_CACHE_HEADER_SET.has(headerName.toLowerCase()) ||
    (includeCacheControl && headerName.toLowerCase() === 'cache-control');
  if (Array.isArray(headers)) {
    return headers.map((entry, index) =>
      index % 2 === 1 && shouldWithdraw(String(headers[index - 1])) ? ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE : entry,
    );
  }
  return Object.fromEntries(
    Object.entries(headers).map(([headerName, headerValue]) => [
      headerName,
      shouldWithdraw(headerName) ? ERROR_RESPONSE_SHARED_CACHE_DIRECTIVE : headerValue,
    ]),
  );
}

function headerArgumentContains(headers: HeadersArgument, name: string, expected?: string): boolean {
  if (Array.isArray(headers)) {
    return headers.some(
      (entry, index) =>
        index % 2 === 0 &&
        String(entry).toLowerCase() === name &&
        (expected === undefined || String(headers[index + 1]) === expected),
    );
  }
  return Object.entries(headers).some(
    ([headerName, headerValue]) =>
      headerName.toLowerCase() === name && (expected === undefined || headerValue === expected),
  );
}

function finalHeader(response: ServerResponse, headerArguments: HeadersArgument[], name: string): string {
  let headerValue = response.getHeader(name);
  for (const headers of headerArguments) {
    if (Array.isArray(headers)) {
      for (let index = 0; index < headers.length; index += 2) {
        if (String(headers[index]).toLowerCase() === name) headerValue = headers[index + 1];
      }
    } else {
      for (const [headerName, argumentValue] of Object.entries(headers)) {
        if (headerName.toLowerCase() === name) headerValue = argumentValue;
      }
    }
  }
  return String(headerValue ?? '');
}

/** Next removes Flight metadata before middleware; inspect the Node request again. */
function isMarketingDocumentRequest(response: ServerResponse): boolean {
  const request = response.req;
  if (!request.url) return false;
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url, 'http://localhost');
  } catch {
    return false;
  }
  return isCacheableMarketingRequest({
    method: request.method ?? '',
    pathname: requestUrl.pathname,
    search: requestUrl.search,
    headers: {
      has: (name) => Object.hasOwn(request.headers, name.toLowerCase()),
      get: (name) => {
        const headerValue = request.headers[name.toLowerCase()];
        return Array.isArray(headerValue) ? headerValue.join('; ') : (headerValue ?? null);
      },
    },
  });
}

/** Next replaces middleware Vary while rendering; merge it at the final write. */
function marketingVary(response: ServerResponse, headerArguments: HeadersArgument[]): string {
  const fields = new Map<string, string>();
  const addFields = (headerValue: OutgoingHttpHeader | undefined) => {
    for (const field of String(headerValue ?? '').split(',')) {
      const trimmedField = field.trim();
      if (trimmedField) fields.set(trimmedField.toLowerCase(), trimmedField);
    }
  };
  addFields(response.getHeader('vary'));
  for (const headers of headerArguments) {
    if (Array.isArray(headers)) {
      headers.forEach((entry, index) => {
        if (index % 2 === 1 && String(headers[index - 1]).toLowerCase() === 'vary') addFields(entry);
      });
    } else {
      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (headerName.toLowerCase() === 'vary') addFields(headerValue);
      }
    }
  }
  addFields(MARKETING_CACHE_VARY);
  return fields.has('*') ? '*' : [...fields.values()].join(', ');
}

function replaceVaryArgument(headers: HeadersArgument, vary: string): HeadersArgument {
  if (Array.isArray(headers)) {
    return headers.map((entry, index) =>
      index % 2 === 1 && String(headers[index - 1]).toLowerCase() === 'vary' ? vary : entry,
    );
  }
  return Object.fromEntries(
    Object.entries(headers).map(([headerName, headerValue]) => [
      headerName,
      headerName.toLowerCase() === 'vary' ? vary : headerValue,
    ]),
  );
}

function isHeadersArgument(argument: unknown): argument is HeadersArgument {
  return typeof argument === 'object' && argument !== null;
}

/**
 * Wraps `writeHead` on the response prototype so a 4xx or 5xx never leaves this
 * process carrying a shared-cache TTL.
 *
 * Why here and not in the middleware: the middleware stamps
 * `CDN-Cache-Control: s-maxage=86400, stale-while-revalidate=604800` on list and
 * climb-view URLs before the page renders, and Next copies middleware headers
 * onto the response with `res.setHeader` before it renders
 * (`next/dist/server/lib/router-server.js`). Nothing on the error paths
 * removes it (all in Next 16.3.5):
 *
 *  - An in-page `notFound()` or a thrown render error lands in app-render's
 *    shell catch (`server/app-render/app-render.js`, the "errorRecovery
 *    classification" block), which only sets `res.statusCode` to 404 or 500 and
 *    renders the fallback. `Cache-Control` comes from
 *    `build/templates/app-page-runtime.js` and `send-payload.js`
 *    `sendRenderResult`, both of which set it only when none is set yet.
 *  - The unmatched-route 404 in `router-server.js` and `base-server.js`
 *    `renderErrorImpl` overwrite `Cache-Control` and leave every other header alone.
 *
 * Cloudflare ranks `CDN-Cache-Control` above `Cache-Control`, so the
 * `boardsesh:www-html-edge-cache` rule stored a
 * one-off 404 for a day plus seven days of stale-while-revalidate. Whether a
 * page will 404 is not knowable in the middleware, so the decision has to be
 * made when the status is final, which is when the head is written.
 *
 * `writeHead` is the one place every response passes through: Next sets
 * `res.statusCode` and streams the body, and Node's `_implicitHeader` calls
 * `this.writeHead(this.statusCode)` on the first write or `end`.
 *
 * Board redirects keep their TTL: the climb-view legacy 308 is cached on purpose.
 * Marketing public Cache-Control is revoked as well on errors, redirects or
 * Set-Cookie, non-HTML responses or ineligible original requests, so an
 * unexpected per-browser or Flight response cannot enter any cache.
 *
 * Returns false when the prototype is already guarded.
 */
export function installErrorResponseCdnCacheGuard(
  responseClass: { prototype: ServerResponse } = ServerResponse,
): boolean {
  const { prototype } = responseClass;
  if (Object.prototype.hasOwnProperty.call(prototype, GUARD_INSTALLED)) return false;

  // Only ever called through Reflect.apply with the response as `this`.
  // oxlint-disable-next-line typescript/unbound-method
  const originalWriteHead = prototype.writeHead;
  function guardedWriteHead(this: ServerResponse, statusCode: number, ...rest: unknown[]): ServerResponse {
    const headerArguments = rest.filter(isHeadersArgument);
    const isMarketing =
      this.getHeader('cache-control') === MARKETING_CACHE_CONTROL ||
      this.getHeader('cdn-cache-control') === MARKETING_CDN_CACHE_CONTROL ||
      headerArguments.some(
        (headers) =>
          headerArgumentContains(headers, 'cache-control', MARKETING_CACHE_CONTROL) ||
          headerArgumentContains(headers, 'cdn-cache-control', MARKETING_CDN_CACHE_CONTROL),
      );
    const hasSetCookie =
      this.hasHeader('set-cookie') || headerArguments.some((headers) => headerArgumentContains(headers, 'set-cookie'));
    const isHtml =
      finalHeader(this, headerArguments, 'content-type').split(';')[0].trim().toLowerCase() === 'text/html';
    const unsafeMarketingResponse =
      isMarketing &&
      (statusCode < 200 || statusCode >= 300 || hasSetCookie || !isHtml || !isMarketingDocumentRequest(this));
    if (!isErrorStatus(Number(statusCode)) && !unsafeMarketingResponse) {
      if (isMarketing) {
        const vary = marketingVary(this, headerArguments);
        this.setHeader('Vary', vary);
        const variedRest = rest.map((argument) =>
          isHeadersArgument(argument) ? replaceVaryArgument(argument, vary) : argument,
        );
        return Reflect.apply(originalWriteHead, this, [statusCode, ...variedRest]) as ServerResponse;
      }
      return Reflect.apply(originalWriteHead, this, [statusCode, ...rest]) as ServerResponse;
    }
    withdrawSharedCacheHeaders(this, isMarketing);
    const guardedRest = rest.map((argument) =>
      isHeadersArgument(argument) ? withdrawSharedCacheFromHeadersArgument(argument, isMarketing) : argument,
    );
    return Reflect.apply(originalWriteHead, this, [statusCode, ...guardedRest]) as ServerResponse;
  }

  prototype.writeHead = guardedWriteHead as unknown as ServerResponse['writeHead'];
  Object.defineProperty(prototype, GUARD_INSTALLED, { value: true });
  return true;
}
