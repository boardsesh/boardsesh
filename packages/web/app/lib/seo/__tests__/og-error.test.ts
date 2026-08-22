// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

type OgErrorModule = typeof import('../og-error');

// Fresh module per test: the throttle map is module state, and a shared
// instance would let one test's log leak the "already logged" cooldown into
// the next test's assertions.
async function loadModule(): Promise<OgErrorModule> {
  vi.resetModules();
  return import('../og-error');
}

describe('ogErrorResponse', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('returns a generic 500 body with no-store, never the raw error message', async () => {
    const { ogErrorResponse } = await loadModule();
    const leakyError = Object.assign(new Error('Failed query: SELECT * FROM users WHERE email = $1'), {
      name: 'DrizzleQueryError',
    });

    const response = ogErrorResponse('setter', leakyError);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toBe('Error generating image');
    expect(body).not.toContain('SELECT');
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
