/**
 * Shared plumbing for the proofs that drive the real `/api/auth/[...nextauth]`
 * route exports: Next's request I/O for NextAuth, a one-host cookie jar, and
 * response normalisation for snapshots. The proofs share a legacy credential fixture
 * and declare their remaining mocks per file.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { vi } from 'vite-plus/test';

export const ORIGIN = 'https://www.boardsesh.com';

/** The request each route call is serving, for Next's request I/O. */
export const servedRequests = new AsyncLocalStorage<NextRequest>();

/** NextAuth's App Router handler requires `next/headers` itself; answer it from the served request. */
export function patchNextRequestIo(): void {
  const nextIo = createRequire(import.meta.url)('next/headers') as {
    headers: () => Promise<Headers>;
    cookies: () => Promise<{ getAll: () => { name: string; value: string }[] }>;
  };
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => servedRequests.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => servedRequests.getStore()?.cookies.getAll() ?? [],
  }));
}

type RouteContext = { params: Promise<{ nextauth: string[] }> };
type RouteHandler = (request: NextRequest, context: RouteContext) => Promise<Response>;
export type AuthRoute = { GET: RouteHandler; POST: RouteHandler };

export type RouteCall = {
  method?: 'GET' | 'POST';
  /** The raw `Cookie` header, exactly as a browser would send it. */
  cookie?: string;
  form?: Record<string, string>;
  /** Other request headers, such as the `X-Forwarded-For` hop a client limit keys on. */
  headers?: Record<string, string>;
};

/** Calls the real route export the way Next would, with the catch-all params it derives from the path. */
export async function callRoute(route: AuthRoute, path: string, call: RouteCall = {}): Promise<Response> {
  const method = call.method ?? (call.form ? 'POST' : 'GET');
  const headers = new Headers(call.headers);
  if (call.cookie) headers.set('cookie', call.cookie);
  if (call.form) headers.set('content-type', 'application/x-www-form-urlencoded');
  const request = new NextRequest(new URL(path, ORIGIN), {
    method,
    headers,
    ...(call.form ? { body: new URLSearchParams(call.form).toString() } : {}),
  });
  const nextauth = new URL(path, ORIGIN).pathname.split('/api/auth/')[1].split('/').filter(Boolean);
  const context = { params: Promise.resolve({ nextauth }) };
  return servedRequests.run(request, () => route[method](request, context));
}

export function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookiePair(setCookie: string): { name: string; value: string } {
  const pair = setCookie.split(';', 1)[0] ?? '';
  const separator = pair.indexOf('=');
  return { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim() };
}

/** Names whose `Set-Cookie` writes or clears a value, in header order. */
export function setCookieNames(response: Response): string[] {
  return setCookies(response).map((header) => cookiePair(header).name);
}

/**
 * A browser's jar for one host. A Domain cookie and a host-only cookie of the
 * same name are two cookies, as in a browser, and both are sent, Domain ones
 * first. A cookie is sent only to paths under its own `Path` (most are `/`).
 * `crossSiteHeader` is what a cross-site POST carries, such as Apple's
 * `form_post`: only the SameSite=None cookies (Lax is the default).
 */
export class CookieJar {
  private readonly values = new Map<
    string,
    { name: string; value: string; domain: string; path: string; sameSite: string }
  >();

  set(name: string, value: string, domain = '', { path = '/', sameSite = 'lax' } = {}): void {
    this.values.set(`${name}|${domain}`, { name, value, domain, path, sameSite });
  }

  get(name: string, domain = ''): string | undefined {
    return this.values.get(`${name}|${domain}`)?.value;
  }

  names(): string[] {
    return [...new Set([...this.values.values()].map((entry) => entry.name))];
  }

  apply(response: Response): void {
    for (const header of setCookies(response)) {
      const { name, value } = cookiePair(header);
      const domain = /;\s*Domain=([^;]+)/i.exec(header)?.[1]?.trim().toLowerCase() ?? '';
      const path = /;\s*Path=([^;]+)/i.exec(header)?.[1]?.trim() ?? '/';
      const sameSite = /;\s*SameSite=([^;]+)/i.exec(header)?.[1]?.trim().toLowerCase() ?? 'lax';
      if (!value || /;\s*Max-Age=0(?:;|$)/i.test(header)) this.values.delete(`${name}|${domain}`);
      else this.set(name, value, domain, { path, sameSite });
    }
  }

  /** The `Cookie` header for a request to `requestPath`. */
  header(requestPath = '/'): string {
    return this.headerOf([...this.values.values()], requestPath);
  }

  /** The `Cookie` header of a cross-site POST to `requestPath`: SameSite=None cookies only. */
  crossSiteHeader(requestPath = '/'): string {
    return this.headerOf(
      [...this.values.values()].filter((entry) => entry.sameSite === 'none'),
      requestPath,
    );
  }

  private headerOf(
    entries: { name: string; value: string; domain: string; path: string }[],
    requestPath: string,
  ): string {
    return entries
      .filter(({ path }) => path === '/' || requestPath === path || requestPath.startsWith(`${path}/`))
      .sort((first, second) => Number(!first.domain) - Number(!second.domain))
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One `Set-Cookie` with its random value and dates replaced, attributes kept in order. */
export function normalizedSetCookie(header: string): string {
  const { name, value } = cookiePair(header);
  const attributes = header
    .slice(header.indexOf(';') === -1 ? header.length : header.indexOf(';'))
    .replace(/Expires=[^;]+/i, 'Expires=<date>');
  return `${name}=${value ? '<value>' : ''}${attributes}`;
}

function normalizedBody(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body), (key, field: unknown) => {
    if (typeof field !== 'string') return field;
    if (key === 'csrfToken') return '<csrf>';
    if (ISO_DATE.test(field)) return '<date>';
    if (UUID.test(field)) return '<uuid>';
    return field;
  });
}

/** Status, body and every `Set-Cookie`, with the parts that change per run replaced. */
export async function normalizedResponse(response: Response) {
  const text = await response.clone().text();
  let body: unknown = text;
  try {
    body = normalizedBody(JSON.parse(text));
  } catch {
    // Not JSON: compare the text as is.
  }
  return {
    status: response.status,
    location: response.headers.get('location'),
    cacheControl: response.headers.get('cache-control'),
    body,
    setCookies: setCookies(response).map(normalizedSetCookie),
  };
}
