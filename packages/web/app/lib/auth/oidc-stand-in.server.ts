// Server code, but without `import 'server-only'`: `instrumentation.ts` runs the
// boot check outside the React server layer that package needs (as browser-session-mode.server.ts).
import { HOSTED_DEPLOYMENT_VARIABLES } from './browser-session-mode.server';

/**
 * The browser-session e2e run's provider stand-ins (#7596 B7c). NextAuth's
 * Google and Apple providers name their issuers' discovery documents as
 * constants, so a run that signs in through a stand-in in a real browser must
 * point the provider elsewhere. This is the one way to do it: the variable
 * names a loopback discovery document, and it is honoured only when www's own
 * origin (`NEXTAUTH_URL`) is an https host under the reserved `boardsesh.test`
 * (RFC 6761: no production host can be one) and no hosting platform runs the
 * process. Set anywhere else, it is refused and www does not boot
 * (`instrumentation.ts`), so production can never sign in against one.
 *
 * Read only here (scripts/__tests__/better-auth-boundary.test.ts).
 */
export const OIDC_STAND_IN_ENV = Object.freeze({
  google: 'BOARDSESH_E2E_GOOGLE_OIDC_WELL_KNOWN',
  apple: 'BOARDSESH_E2E_APPLE_OIDC_WELL_KNOWN',
} as const);

export const OIDC_STAND_IN_REFUSED = 'AUTH_OIDC_STAND_IN_OUTSIDE_TEST';

type StandInProvider = keyof typeof OIDC_STAND_IN_ENV;
type Environment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function onReservedTestOrigin(environment: Environment): boolean {
  if (HOSTED_DEPLOYMENT_VARIABLES.some((name) => (environment[name] ?? '') !== '')) return false;
  try {
    const origin = new URL(environment.NEXTAUTH_URL ?? '');
    return origin.protocol === 'https:' && origin.hostname.toLowerCase().endsWith('.boardsesh.test');
  } catch {
    return false;
  }
}

function isLoopbackDocument(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The stand-in discovery document for `provider`, undefined when none is set.
 * Throws `OIDC_STAND_IN_REFUSED` when one is set where it must never be, or
 * names anything but a loopback document.
 */
export function oidcStandInWellKnown(
  provider: StandInProvider,
  environment: Environment = process.env,
): string | undefined {
  const value = environment[OIDC_STAND_IN_ENV[provider]];
  if (value === undefined || value === '') return undefined;
  if (!onReservedTestOrigin(environment) || !isLoopbackDocument(value)) throw new Error(OIDC_STAND_IN_REFUSED);
  return value;
}

/** For `instrumentation.ts`: the error that must stop this process from serving, or undefined. */
export function oidcStandInBootRefusal(environment: Environment = process.env): Error | undefined {
  for (const provider of Object.keys(OIDC_STAND_IN_ENV) as StandInProvider[]) {
    try {
      oidcStandInWellKnown(provider, environment);
    } catch (error) {
      return error instanceof Error ? error : new Error(OIDC_STAND_IN_REFUSED);
    }
  }
  return undefined;
}
