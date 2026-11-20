/**
 * What the global setup hands the specs: the hosts, the proxy and where the
 * stack listens. Passed as JSON in one environment variable, because Playwright
 * starts its workers after the global setup and they inherit its environment.
 */

export const STACK_ENVIRONMENT_VARIABLE = 'BROWSER_SESSION_E2E_STACK';
/** Where `scripts/browser-session-e2e.ts` put the standalone Expo web export. */
export const APP_EXPORT_ENVIRONMENT_VARIABLE = 'BROWSER_SESSION_E2E_APP_EXPORT';

/**
 * One parent domain, three real HTTPS hosts under it, as in production
 * (boardsesh.com, www, app, ws). `.test` is reserved (RFC 6761), so these names
 * can never reach a real site, and no browser resolves them: both engines send
 * every request to the local proxy, which tunnels only these hosts.
 */
export const PARENT_DOMAIN = 'boardsesh.test';
export const WWW_HOST = `www.${PARENT_DOMAIN}`;
export const APP_HOST = `app.${PARENT_DOMAIN}`;
export const WS_HOST = `ws.${PARENT_DOMAIN}`;
/** Two more hosts under the parent, served by a cookie echo, for the engine probe. */
export const PROBE_HOST_ONE = `probe-one.${PARENT_DOMAIN}`;
export const PROBE_HOST_TWO = `probe-two.${PARENT_DOMAIN}`;
/**
 * The Apple stand-in's sign-in page (auth-proofs/apple-oidc-fixture.ts), on
 * another site than the parent domain, so its form_post reaches www
 * cross-site exactly as Apple's does: with SameSite=None cookies only.
 */
export const APPLE_STAND_IN_HOST = 'appleid.apple-stand-in.test';
export const APPLE_STAND_IN_ORIGIN = `https://${APPLE_STAND_IN_HOST}`;
/** Google's sign-in page, played the same way (auth-proofs/google-oidc-fixture.ts), on its own site too. */
export const GOOGLE_STAND_IN_HOST = 'accounts.google-stand-in.test';
export const GOOGLE_STAND_IN_ORIGIN = `https://${GOOGLE_STAND_IN_HOST}`;
export const GOOGLE_STAND_IN_CLIENT = Object.freeze({
  clientId: 'browser-session-e2e-google-client',
  clientSecret: 'browser-session-e2e-google-client-secret',
});
/** The client www and the backend are configured with for it. Not a secret: the stand-in only compares it. */
export const APPLE_STAND_IN_CLIENT = Object.freeze({
  clientId: 'browser-session-e2e-apple-client',
  clientSecret: 'browser-session-e2e-apple-client-secret',
});

export const WWW_ORIGIN = `https://${WWW_HOST}`;
export const APP_ORIGIN = `https://${APP_HOST}`;
export const BACKEND_ORIGIN = `https://${WS_HOST}`;
export const GRAPHQL_URL = `wss://${WS_HOST}/graphql`;

/** The `Domain` the session cookie is written with: the production shape, `.boardsesh.com`. */
export const COOKIE_DOMAIN = `.${PARENT_DOMAIN}`;

/** What `database.ts` prints its seed result after, and the id prefix of the one account it creates. */
export const SEED_OUTPUT_PREFIX = 'BROWSER_SESSION_E2E_SEED=';
export const ACCOUNT_ID_PREFIX = 'browser-session-e2e-';

/** `next dev`, or `next build` then `next start` (BROWSER_SESSION_E2E_WWW=production). */
export type WwwMode = 'dev' | 'production';

/** An account a spec can sign in as. `userId` is the `sub` of its session. */
export interface SeededAccount {
  userId: string;
  email: string;
  password: string;
  name: string;
}

/** What the edge saw one response set, with names and attributes only (never a value). */
export interface SetCookieRecord {
  host: string;
  method: string;
  /** Path without its query string. */
  path: string;
  status: number;
  /** `valueDigest` is a 16-hex SHA-256 prefix of the value (edge.ts), never the value. */
  setCookies: Array<{ name: string; attributes: string[]; clears: boolean; valueDigest: string }>;
}

export interface BrowserSessionStack {
  /** The browsers' HTTP proxy. It tunnels only to the hosts above. */
  proxyServer: string;
  /** The seeded dev-database account, and a second one made for this run. */
  accounts: { accountA: SeededAccount; accountB: SeededAccount };
  /** This run's NextAuth secret, to mint legacy sessions with. It guards a throwaway database and dies with the run. */
  nextAuthSecret: string;
  wwwMode: WwwMode;
  /** The `AUTH_BROWSER_SESSION_MODE` the run started both servers in. `restartStack` can change it. */
  browserSessionMode: 'legacy' | 'better-auth';
  /** The local dev database, for the specs' own database steps (`database.ts`). Never a remote one. */
  databaseUrl: string;
  /** The id prefix of every account this run makes; teardown deletes them together. */
  runAccountPrefix: string;
  /** The setup process's control server: restarts and the Set-Cookie log. Loopback only, token required. */
  control: { url: string; token: string };
}

/**
 * Session cookies of either auth stack, chunks included: NextAuth's
 * (`__Secure-next-auth.session-token`, `.1`, ...) and the first-party login and
 * bridged cookies (`__Secure-boardsesh.session_token`,
 * `__Secure-boardsesh.bridged_session_token`).
 */
export const SESSION_COOKIE_NAME = /(?:next-auth|better-auth|boardsesh)\.(?:bridged_)?session[_-]?token(?:\.\d+)?$/;

/** The first-party cookie names in a secure context (`@boardsesh/auth-protocol/browser-session-cookie`). */
export const LOGIN_COOKIE = '__Secure-boardsesh.session_token';
export const BRIDGED_COOKIE = '__Secure-boardsesh.bridged_session_token';
export const LEGACY_COOKIE = '__Secure-next-auth.session-token';
/** The viewer marker (#7596): readable, written and cleared only beside a session cookie. */
export const MARKER_COOKIE = '__Secure-boardsesh.viewer';

export function readStack(): BrowserSessionStack {
  const raw = process.env[STACK_ENVIRONMENT_VARIABLE];
  if (!raw) {
    throw new Error(
      `${STACK_ENVIRONMENT_VARIABLE} is not set. Run this suite with \`vp run test:e2e:browser-session\`, whose global setup starts the stack.`,
    );
  }
  return JSON.parse(raw) as BrowserSessionStack;
}
