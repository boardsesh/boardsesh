import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { assertBrowserSessionModeConfiguration, readBrowserSessionMode } from '../browser-session-mode';

// Phase A of #7596: nothing serves a Better Auth browser session yet, so the
// only start the backend accepts is the legacy NextAuth one.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('readBrowserSessionMode', () => {
  it('reads AUTH_BROWSER_SESSION_MODE from the process environment by default', () => {
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'better-auth');
    expect(readBrowserSessionMode()).toBe('better-auth');
  });

  it.each([undefined, '', 'legacy'])('reads %j as legacy', (rawMode) => {
    expect(readBrowserSessionMode(rawMode)).toBe('legacy');
  });
});

describe('assertBrowserSessionModeConfiguration', () => {
  it.each([{}, { AUTH_BROWSER_SESSION_MODE: '' }, { AUTH_BROWSER_SESSION_MODE: 'legacy' }])(
    'starts on the legacy session with %j',
    (environment) => {
      expect(() => assertBrowserSessionModeConfiguration(environment)).not.toThrow();
    },
  );

  it.each(['Legacy', 'better_auth', 'on', ' legacy'])('refuses the unknown value %j', (rawMode) => {
    expect(() => assertBrowserSessionModeConfiguration({ AUTH_BROWSER_SESSION_MODE: rawMode })).toThrow(
      'AUTH_BROWSER_SESSION_MODE_INVALID',
    );
  });

  it.each(['production', 'test', 'development'])(
    'refuses better-auth with NODE_ENV=%s until B1 lands',
    (nodeEnvironment) => {
      expect(() =>
        assertBrowserSessionModeConfiguration({
          NODE_ENV: nodeEnvironment,
          AUTH_BROWSER_SESSION_MODE: 'better-auth',
        }),
      ).toThrow('B1 (#7596) has not landed');
    },
  );
});

describe('backend startup', () => {
  it.each([
    ['an unknown value', 'better_auth', 'AUTH_BROWSER_SESSION_MODE_INVALID'],
    ['better-auth', 'better-auth', 'B1 (#7596) has not landed'],
  ])('refuses %s before any external initialization', async (_label, rawMode, refusal) => {
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', rawMode);
    // The database client is built on import but never connects here.
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:1/unused');
    const { pubsub } = await import('../../../pubsub/index');
    const initialize = vi.spyOn(pubsub, 'initialize').mockRejectedValue(new Error('UNEXPECTED_STARTUP_IO'));
    const { startServer } = await import('../../../server');
    await expect(startServer()).rejects.toThrow(refusal);
    expect(initialize).not.toHaveBeenCalled();
  });
});
