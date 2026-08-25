import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  ALLOW_MISSING_CANONICAL_ORIGIN_ENV_VAR,
  applyCanonicalAuthUrl,
  type AuthEnv,
  diagnoseCanonicalOrigin,
  resolveCanonicalAuthUrl,
} from '../canonical-auth-url';

// Every case drives an explicit env object, so nothing here depends on the
// ambient process env.
const PROD_ORIGIN = 'https://www.boardsesh.com';

const HOSTED_ENVS: AuthEnv[] = [
  { VERCEL: '1', VERCEL_ENV: 'production' },
  { NEXTAUTH_URL: 'http://localhost:3000', VERCEL_ENV: 'production' },
  { NEXTAUTH_URL: 'http://127.0.0.1:3000', VERCEL: '1' },
  { NEXTAUTH_URL: 'http://localhost:3000', BASE_URL: PROD_ORIGIN },
  { NEXTAUTH_URL: 'http://localhost:3000', VERCEL_URL: 'boardsesh-abc.vercel.app' },
  { NEXTAUTH_URL: 'http://localhost:3000', AUTH_COOKIE_DOMAIN: '.boardsesh.com', VERCEL_ENV: 'production' },
  { BASE_URL: PROD_ORIGIN },
  { VERCEL_ENV: 'preview', VERCEL_URL: 'boardsesh-abc.vercel.app' },
  { VERCEL_ENV: 'preview', VERCEL_URL: 'boardsesh-abc.vercel.app', BASE_URL: PROD_ORIGIN },
];

// The tracked `packages/web/.env.local` that every developer runs with. Nothing
// in it may be read as a hosting signal.
const LOCAL_DEV_ENV: AuthEnv = {
  VERCEL_ENV: 'development',
  BASE_URL: 'http://localhost:3000',
  NEXTAUTH_URL: 'http://localhost:3000',
};

function expectNotLoopback(origin: string, env: AuthEnv): void {
  const { hostname } = new URL(origin);
  const label = JSON.stringify(env);
  expect(hostname, label).not.toMatch(/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/);
  expect(hostname.endsWith('.localhost'), label).toBe(false);
}

describe('resolveCanonicalAuthUrl', () => {
  it('returns the canonical origin on Vercel production when NEXTAUTH_URL is unset', () => {
    expect(resolveCanonicalAuthUrl({ VERCEL: '1', VERCEL_ENV: 'production' })).toBe(PROD_ORIGIN);
  });

  it('ignores a loopback NEXTAUTH_URL on a hosted deployment (the issue-4227 state)', () => {
    expect(resolveCanonicalAuthUrl({ NEXTAUTH_URL: 'http://localhost:3000', VERCEL_ENV: 'production' })).toBe(
      PROD_ORIGIN,
    );
  });

  it('ignores loopback aliases too', () => {
    for (const loopback of ['http://127.0.0.1:3000', 'http://[::1]:3000', 'http://app.localhost:3000']) {
      expect(resolveCanonicalAuthUrl({ NEXTAUTH_URL: loopback, VERCEL_ENV: 'production' })).toBe(PROD_ORIGIN);
    }
  });

  it('returns an explicit https NEXTAUTH_URL verbatim, trailing slash included', () => {
    // The redirect callback compares origins, not raw strings, so the trailing
    // slash is harmless — and operators expect the value they set to be used.
    expect(resolveCanonicalAuthUrl({ NEXTAUTH_URL: `${PROD_ORIGIN}/`, VERCEL_ENV: 'production' })).toBe(
      `${PROD_ORIGIN}/`,
    );
  });

  it('prefers an explicit NEXTAUTH_URL over every other signal', () => {
    expect(
      resolveCanonicalAuthUrl({
        NEXTAUTH_URL: 'https://42.preview.boardsesh.com',
        BASE_URL: PROD_ORIGIN,
        VERCEL_ENV: 'production',
        VERCEL_URL: 'boardsesh-abc.vercel.app',
      }),
    ).toBe('https://42.preview.boardsesh.com');
  });

  it('falls back to BASE_URL when there is no NEXTAUTH_URL (the Dockerfile.web path)', () => {
    expect(resolveCanonicalAuthUrl({ BASE_URL: PROD_ORIGIN })).toBe(PROD_ORIGIN);
  });

  it('falls back to the Vercel deployment URL on a preview', () => {
    expect(resolveCanonicalAuthUrl({ VERCEL_ENV: 'preview', VERCEL_URL: 'boardsesh-abc.vercel.app' })).toBe(
      'https://boardsesh-abc.vercel.app',
    );
  });

  it('returns undefined for an empty env so local dev keeps the next-auth localhost default', () => {
    expect(resolveCanonicalAuthUrl({})).toBeUndefined();
  });

  it('leaves a loopback NEXTAUTH_URL alone when nothing says the deployment is hosted', () => {
    expect(resolveCanonicalAuthUrl({ NEXTAUTH_URL: 'http://localhost:3000' })).toBeUndefined();
  });

  it('does not treat the tracked local dev env as a hosted deployment', () => {
    // `VERCEL_ENV=development` and a loopback `BASE_URL` are both in the tracked
    // packages/web/.env.local. Reading either as hosting would strip a developer's
    // NEXTAUTH_URL on every boot.
    expect(resolveCanonicalAuthUrl(LOCAL_DEV_ENV)).toBeUndefined();
  });

  it('keeps a non-3000 local dev port', () => {
    // `PORT=3095 vp run dev` is a supported workflow. Dropping NEXTAUTH_URL here
    // would send next-auth back to its :3000 default and break local sign-in.
    expect(resolveCanonicalAuthUrl({ ...LOCAL_DEV_ENV, NEXTAUTH_URL: 'http://localhost:3095' })).toBeUndefined();
  });

  it('prefers the preview deployment URL over a BASE_URL set for every Vercel environment', () => {
    // A preview inheriting the production origin would make sessionCookieDomain()
    // emit Domain=.boardsesh.com from a *.vercel.app response, which the browser
    // rejects — the preview login would silently never store a cookie.
    expect(
      resolveCanonicalAuthUrl({
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'boardsesh-abc.vercel.app',
        BASE_URL: PROD_ORIGIN,
      }),
    ).toBe('https://boardsesh-abc.vercel.app');
  });

  it('still uses BASE_URL on a Vercel production deployment', () => {
    expect(
      resolveCanonicalAuthUrl({ VERCEL_ENV: 'production', VERCEL_URL: 'x.vercel.app', BASE_URL: PROD_ORIGIN }),
    ).toBe(PROD_ORIGIN);
  });

  it('falls through instead of throwing on an unparseable NEXTAUTH_URL', () => {
    expect(resolveCanonicalAuthUrl({ NEXTAUTH_URL: 'not a url', VERCEL_ENV: 'production' })).toBe(PROD_ORIGIN);
    expect(resolveCanonicalAuthUrl({ NEXTAUTH_URL: 'not a url' })).toBeUndefined();
  });

  it('ignores a loopback BASE_URL', () => {
    expect(resolveCanonicalAuthUrl({ BASE_URL: 'http://localhost:3000', VERCEL_ENV: 'production' })).toBe(PROD_ORIGIN);
  });

  // The direct regression assert for #4227: a hosted deployment must never
  // hand next-auth an origin that would produce a loopback redirect_uri.
  it('never resolves to a loopback host on any hosted deployment', () => {
    for (const env of HOSTED_ENVS) {
      const resolved = resolveCanonicalAuthUrl(env);
      if (resolved === undefined) continue;
      expectNotLoopback(resolved, env);
    }
  });

  it('resolves an origin for every hosted env that names one', () => {
    for (const env of HOSTED_ENVS.filter((env) => env.VERCEL_ENV || env.VERCEL_URL || env.BASE_URL)) {
      expect(resolveCanonicalAuthUrl(env), JSON.stringify(env)).toBeDefined();
    }
  });
});

describe('applyCanonicalAuthUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rewrites a loopback NEXTAUTH_URL on a hosted deployment and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: AuthEnv = { NEXTAUTH_URL: 'http://localhost:3000', VERCEL_ENV: 'production' };

    expect(applyCanonicalAuthUrl(env)).toBe(PROD_ORIGIN);
    expect(env.NEXTAUTH_URL).toBe(PROD_ORIGIN);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second call changes nothing and stays quiet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: AuthEnv = { VERCEL_ENV: 'production' };

    applyCanonicalAuthUrl(env);
    warn.mockClear();
    expect(applyCanonicalAuthUrl(env)).toBe(PROD_ORIGIN);
    expect(env.NEXTAUTH_URL).toBe(PROD_ORIGIN);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a correct https NEXTAUTH_URL untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: AuthEnv = { NEXTAUTH_URL: PROD_ORIGIN, VERCEL_ENV: 'production' };

    expect(applyCanonicalAuthUrl(env)).toBe(PROD_ORIGIN);
    expect(env.NEXTAUTH_URL).toBe(PROD_ORIGIN);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not invent a NEXTAUTH_URL in local dev', () => {
    const env: AuthEnv = {};
    expect(applyCanonicalAuthUrl(env)).toBeUndefined();
    expect(env.NEXTAUTH_URL).toBeUndefined();
  });

  it('leaves the tracked local dev env untouched and stays quiet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: AuthEnv = { ...LOCAL_DEV_ENV };

    expect(applyCanonicalAuthUrl(env)).toBeUndefined();
    expect(env.NEXTAUTH_URL).toBe('http://localhost:3000');
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops a loopback NEXTAUTH_URL when hosted but no canonical origin is derivable', () => {
    // VERCEL alone (system env vars not exposed) names no origin. Dropping the
    // poison value lets next-auth derive the origin from the platform-set
    // forwarded host instead of hard-coding a localhost redirect URI.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: AuthEnv = { NEXTAUTH_URL: 'http://127.0.0.1:3000', VERCEL: '1' };

    expect(applyCanonicalAuthUrl(env)).toBeUndefined();
    expect(env.NEXTAUTH_URL).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // The end-to-end regression guarantee for #4227.
  it('leaves no hosted deployment holding a loopback NEXTAUTH_URL', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const hostedEnv of HOSTED_ENVS) {
      const env: AuthEnv = { ...hostedEnv };
      applyCanonicalAuthUrl(env);
      if (env.NEXTAUTH_URL) expectNotLoopback(env.NEXTAUTH_URL, hostedEnv);
    }
  });

  it('says nothing at all when a hosted deployment names no origin and NEXTAUTH_URL is simply absent', () => {
    // The gap diagnoseCanonicalOrigin exists to close: the backstop needs a
    // PARSEABLE loopback value before it warns, so an absent NEXTAUTH_URL is
    // total silence — which is precisely the state Dockerfile.web's runner
    // stage shipped before #4651.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: AuthEnv = { NODE_ENV: 'production' };

    expect(applyCanonicalAuthUrl(env)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('diagnoseCanonicalOrigin', () => {
  const PRODUCTION_SERVER: AuthEnv = { NODE_ENV: 'production' };

  it('is fatal on a production server that names no origin at all (the Railway container bug)', () => {
    const diagnosis = diagnoseCanonicalOrigin({ ...PRODUCTION_SERVER, DATABASE_URL: 'postgres://db/main' });

    expect(diagnosis.level).toBe('fatal');
    // The message has to name what to set; an operator reading a crashed boot
    // log gets one shot at understanding it.
    expect(diagnosis.level === 'fatal' && diagnosis.message).toContain('NEXTAUTH_URL');
    expect(diagnosis.level === 'fatal' && diagnosis.message).toContain('BASE_URL');
  });

  it('is ok on Railway production once the canonical origin is set', () => {
    expect(diagnoseCanonicalOrigin({ ...PRODUCTION_SERVER, NEXTAUTH_URL: PROD_ORIGIN })).toEqual({ level: 'ok' });
    expect(diagnoseCanonicalOrigin({ ...PRODUCTION_SERVER, BASE_URL: PROD_ORIGIN })).toEqual({ level: 'ok' });
  });

  it('is ok on Vercel production, where the loopback env file is overridden by the resolver', () => {
    // Measured production state: .env.local supplies loopback values and
    // VERCEL_ENV resolves the canonical origin over the top of them. Booting
    // must not become conditional on Vercel project env being fixed first.
    expect(
      diagnoseCanonicalOrigin({
        ...PRODUCTION_SERVER,
        VERCEL: '1',
        VERCEL_ENV: 'production',
        VERCEL_URL: 'boardsesh-abc.vercel.app',
        NEXTAUTH_URL: 'http://localhost:3000',
        BASE_URL: 'http://localhost:3000',
      }),
    ).toEqual({ level: 'ok' });
  });

  it('is ok on a Vercel preview', () => {
    expect(
      diagnoseCanonicalOrigin({
        ...PRODUCTION_SERVER,
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'boardsesh-abc.vercel.app',
      }),
    ).toEqual({ level: 'ok' });
  });

  it('is ok on the homelab branch-deploy container', () => {
    expect(diagnoseCanonicalOrigin({ ...PRODUCTION_SERVER, NEXTAUTH_URL: 'https://42.preview.boardsesh.com' })).toEqual(
      { level: 'ok' },
    );
  });

  it('only warns when a production server names a loopback origin', () => {
    // `next start` on a laptop and the CI e2e server (which sets
    // NEXTAUTH_URL=http://localhost:3000) are indistinguishable at boot from a
    // host handed a copy of .env.local. Failing those closed would brick both.
    const diagnosis = diagnoseCanonicalOrigin({ ...PRODUCTION_SERVER, ...LOCAL_DEV_ENV });

    expect(diagnosis.level).toBe('warn');
    expect(diagnosis.level === 'warn' && diagnosis.message).toContain('http://localhost:3000');
  });

  it('is silent on a developer machine and in a test runner', () => {
    expect(diagnoseCanonicalOrigin({})).toEqual({ level: 'ok' });
    expect(diagnoseCanonicalOrigin(LOCAL_DEV_ENV)).toEqual({ level: 'ok' });
    expect(diagnoseCanonicalOrigin({ NODE_ENV: 'development' })).toEqual({ level: 'ok' });
    expect(diagnoseCanonicalOrigin({ NODE_ENV: 'test' })).toEqual({ level: 'ok' });
    // A fixture that forces NODE_ENV=production inside vitest is still a test.
    expect(diagnoseCanonicalOrigin({ ...PRODUCTION_SERVER, VITEST: 'true' })).toEqual({ level: 'ok' });
  });

  it('downgrades the fatal to a warning when the operator sets the bypass', () => {
    for (const bypassValue of ['1', 'true', 'TRUE']) {
      const diagnosis = diagnoseCanonicalOrigin({
        ...PRODUCTION_SERVER,
        [ALLOW_MISSING_CANONICAL_ORIGIN_ENV_VAR]: bypassValue,
      });
      expect(diagnosis.level, bypassValue).toBe('warn');
    }
    // Anything else is not a bypass — a stray empty value must not disarm it.
    expect(diagnoseCanonicalOrigin({ ...PRODUCTION_SERVER, [ALLOW_MISSING_CANONICAL_ORIGIN_ENV_VAR]: '' }).level).toBe(
      'fatal',
    );
  });

  it('does not fire for an empty-string origin variable', () => {
    // Dockerfile.web's runner declares `ENV BASE_URL=$BASE_URL`, which is the
    // empty string when the image is built without the build arg. An empty
    // value names nothing, so it must still be fatal rather than pass the check.
    expect(diagnoseCanonicalOrigin({ ...PRODUCTION_SERVER, BASE_URL: '', NEXTAUTH_URL: '' }).level).toBe('fatal');
  });

  it('mutates nothing', () => {
    const env: AuthEnv = { ...PRODUCTION_SERVER };
    diagnoseCanonicalOrigin(env);
    expect(env).toEqual({ NODE_ENV: 'production' });
  });
});
