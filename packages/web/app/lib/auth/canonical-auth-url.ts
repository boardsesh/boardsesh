import { SITE_URL } from '@/app/lib/seo/base-url';

// next-auth v4 resolves the origin it builds every auth URL from (including the
// OAuth `redirect_uri`) in `utils/detect-origin.js`: it returns
// `process.env.NEXTAUTH_URL` first, falls back to the forwarded host ONLY when
// `VERCEL` or `AUTH_TRUST_HOST` is set, and otherwise returns undefined — at
// which point `utils/parse-url.js` defaults to `http://localhost:3000`.
//
// In production that default is user-visible: Google sign-in on
// www.boardsesh.com sent `redirect_uri=http://localhost:3000/api/auth/callback/google`
// and dropped everyone on a dead localhost page (issue #4227). The same root
// cause silently disabled the `.boardsesh.com` shared session cookie, because
// `sessionCookieDomain()` keys on the NEXTAUTH_URL hostname.
//
// This module derives the canonical origin from whatever the deployment does
// tell us and writes it back into `process.env.NEXTAUTH_URL` before next-auth
// reads it, so a hosted deployment can never produce a loopback redirect URI.
//
// Deliberately NOT solved with `AUTH_TRUST_HOST`: that makes next-auth build the
// redirect URI out of the `X-Forwarded-Host` header, which is host-header
// injection surface. A static canonical origin is the safer shape.

// `NodeJS.ProcessEnv` is augmented with a required `NODE_ENV` in the Next types,
// which makes it useless as a parameter type for a function that also accepts
// small literal env objects. This is the shape both `process.env` and those
// literals satisfy.
export type AuthEnv = Record<string, string | undefined>;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost');
}

function parseAbsoluteHttpUrl(value: string | undefined): URL | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : undefined;
}

// The value verbatim (trailing slash and all) when it parses as an http(s) URL
// on a real host, otherwise undefined. Operators expect the value they set to be
// the value that is used, and the redirect callback compares origins rather than
// raw strings, so no normalisation happens here.
function nonLoopbackOrigin(value: string | undefined): string | undefined {
  const parsed = parseAbsoluteHttpUrl(value);
  if (!parsed || isLoopbackHostname(parsed.hostname)) return undefined;
  return value?.trim();
}

// Vercel sets VERCEL_ENV to 'production' | 'preview' | 'development'. Only the
// first two are deployments — and the tracked `packages/web/.env.local` sets
// `development` on every developer machine, so treating a bare VERCEL_ENV as
// hosting would make local dev look like a misconfigured deployment.
const HOSTED_VERCEL_ENVS = new Set(['production', 'preview']);

// True when the deployment is clearly running on hosting rather than on a
// developer's machine. Only in that case is a loopback NEXTAUTH_URL treated as
// a misconfiguration to be ignored — local dev keeps its own localhost value
// (which may be on a non-3000 port, e.g. `PORT=3095 vp run dev`) untouched.
function isHostedDeployment(env: AuthEnv): boolean {
  return Boolean(
    env.VERCEL ||
    HOSTED_VERCEL_ENVS.has(env.VERCEL_ENV?.trim() ?? '') ||
    env.VERCEL_URL?.trim() ||
    // A loopback BASE_URL is the dev default, not a hosting signal.
    nonLoopbackOrigin(env.BASE_URL) ||
    env.AUTH_COOKIE_DOMAIN?.trim(),
  );
}

/**
 * The origin next-auth should treat as this deployment's base URL, or
 * `undefined` when nothing in the environment identifies one (local dev, where
 * next-auth's own `http://localhost:3000` default is correct).
 *
 * Pure: reads only the passed env, mutates nothing.
 */
export function resolveCanonicalAuthUrl(env: AuthEnv = process.env): string | undefined {
  const explicit = nonLoopbackOrigin(env.NEXTAUTH_URL);
  if (explicit) return explicit;

  // Past this point NEXTAUTH_URL is unset, unparseable, or loopback. A loopback
  // value on a developer machine is correct, so only override when hosted.
  if (parseAbsoluteHttpUrl(env.NEXTAUTH_URL) && !isHostedDeployment(env)) return undefined;

  const vercelEnv = env.VERCEL_ENV?.trim();
  const vercelUrl = env.VERCEL_URL?.trim();

  // A Vercel preview uses its own deployment URL ahead of BASE_URL. BASE_URL is
  // the email base URL and is commonly set once for every Vercel environment, so
  // honouring it here would hand a preview the production origin — which sends
  // preview OAuth back to prod AND makes sessionCookieDomain() emit
  // `Domain=.boardsesh.com` on a `*.vercel.app` response, where the browser
  // rejects it and the preview login silently never stores a cookie (the exact
  // failure secure-cookies.ts is written to prevent).
  if (vercelEnv === 'preview' && vercelUrl) return `https://${vercelUrl}`;

  const baseUrl = nonLoopbackOrigin(env.BASE_URL);
  if (baseUrl) return baseUrl;

  if (vercelEnv === 'production') return SITE_URL;

  if (vercelUrl) return `https://${vercelUrl}`;

  return undefined;
}

/**
 * Writes the canonical origin into `env.NEXTAUTH_URL` when it differs from what
 * is already there, so next-auth (and our cookie-domain helpers) read a correct
 * value. Idempotent; returns the applied value, or `undefined` when nothing was
 * resolved.
 */
export function applyCanonicalAuthUrl(env: AuthEnv = process.env): string | undefined {
  const resolved = resolveCanonicalAuthUrl(env);
  if (!resolved) {
    // Hosted, but nothing in the env names the canonical origin — and the only
    // thing NEXTAUTH_URL says is "localhost". Dropping it is strictly better
    // than keeping it: next-auth's own detect-origin then derives the origin
    // from the (platform-set) forwarded host when VERCEL is present, instead of
    // hard-coding a loopback redirect URI. This is a backstop for a
    // misconfigured deployment, not a supported configuration.
    const loopback = parseAbsoluteHttpUrl(env.NEXTAUTH_URL);
    if (loopback && isLoopbackHostname(loopback.hostname) && isHostedDeployment(env)) {
      console.warn(
        `[auth] NEXTAUTH_URL is "${env.NEXTAUTH_URL}" on a hosted deployment and no canonical origin could be ` +
          'derived; ignoring it. Set NEXTAUTH_URL to the canonical https origin.',
      );
      delete env.NEXTAUTH_URL;
    }
    return undefined;
  }
  const current = env.NEXTAUTH_URL;
  if (current !== resolved) {
    // The only signal an operator gets that the deployment env var is wrong.
    console.warn(
      `[auth] NEXTAUTH_URL ${current ? `is "${current}"` : 'is not set'}; using "${resolved}" as the auth base URL. ` +
        'Set NEXTAUTH_URL to the canonical https origin in this deployment.',
    );
    env.NEXTAUTH_URL = resolved;
  }
  return resolved;
}
