// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: captureExceptionMock,
}));

type OgErrorModule = typeof import('../og-error');

// Fresh module per test: the throttle map is module state, and a shared
// instance would let one test's log leak the "already logged" cooldown into
// the next test's assertions.
async function loadModule(): Promise<OgErrorModule> {
  vi.resetModules();
  return import('../og-error');
}

/**
 * Mirrors real drizzle-orm@0.45.2's `DrizzleQueryError` (see
 * `node_modules/drizzle-orm/errors.js`): the class never overrides `.name`,
 * so it stays the inherited "Error" rather than "DrizzleQueryError"; the
 * message is `Failed query: <sql>\nparams: <params>`; and `.cause` is always
 * the underlying driver error. Modelling that (instead of a fake with the SQL
 * inlined and no cause) is what makes the "log never contains SELECT"
 * assertions below mean something — a bug in `compactErrorMessage`'s
 * cause-unwrapping would fail them.
 */
function makeDrizzleQueryError(sql: string, params: string, causeMessage = 'CONNECT_TIMEOUT'): Error {
  const cause = Object.assign(new Error(causeMessage), { code: causeMessage });
  return Object.assign(new Error(`Failed query: ${sql}\nparams: ${params}`), { cause });
}

describe('ogErrorResponse', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    captureExceptionMock.mockClear();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('redirects to the branded fallback card with a short CDN-cacheable TTL, never the raw error message', async () => {
    const { ogErrorResponse } = await loadModule();
    const leakyError = makeDrizzleQueryError('SELECT * FROM users WHERE email = $1', 'test@boardsesh.com');

    const response = ogErrorResponse('setter', leakyError);
    const body = await response.text();

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/opengraph-image');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=60');
    expect(response.headers.get('CDN-Cache-Control')).toBe('public, s-maxage=60');
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('public, s-maxage=60');
    expect(body).not.toContain('SELECT');

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [, loggedMessage] = consoleErrorSpy.mock.calls[0] as [string, string];
    expect(loggedMessage).not.toContain('SELECT');
    expect(loggedMessage).not.toContain('test@boardsesh.com');
    expect(loggedMessage).toBe('Error: CONNECT_TIMEOUT');
  });

  it('reports the failure to Sentry, tagged by surface and route, inside the same throttle gate', async () => {
    const { ogErrorResponse } = await loadModule();
    const leakyError = makeDrizzleQueryError('SELECT * FROM users WHERE email = $1', 'test@boardsesh.com');

    ogErrorResponse('setter', leakyError);
    ogErrorResponse('setter', leakyError);
    ogErrorResponse('setter', leakyError);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(leakyError, { tags: { surface: 'og', route: 'setter' } });
  });

  it('logs a compact message the first time a route fails', async () => {
    const { ogErrorResponse } = await loadModule();

    ogErrorResponse('profile', new Error('boom'));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('[og] profile render failed:', 'Error: boom');
  });

  it('throttles repeated failures on the same route to once per 60s', async () => {
    const { ogErrorResponse } = await loadModule();

    ogErrorResponse('playlist', new Error('first'));
    ogErrorResponse('playlist', new Error('second'));
    ogErrorResponse('playlist', new Error('third'));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(59_999);
    ogErrorResponse('playlist', new Error('fourth'));
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    ogErrorResponse('playlist', new Error('fifth'));
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenLastCalledWith('[og] playlist render failed:', 'Error: fifth');
  });

  it('tracks each route independently', async () => {
    const { ogErrorResponse } = await loadModule();

    ogErrorResponse('session', new Error('a'));
    ogErrorResponse('climb', new Error('b'));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
  });
});
