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

export const WWW_ORIGIN = `https://${WWW_HOST}`;
export const APP_ORIGIN = `https://${APP_HOST}`;
export const BACKEND_ORIGIN = `https://${WS_HOST}`;
export const GRAPHQL_URL = `wss://${WS_HOST}/graphql`;

/** The `Domain` the session cookie is written with: the production shape, `.boardsesh.com`. */
export const COOKIE_DOMAIN = `.${PARENT_DOMAIN}`;

/** The seeded dev-database account every run signs in as (e2e/SEED_CONTRACT.md). */
export const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com';
export const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'test';

export interface BrowserSessionStack {
  /** The browsers' HTTP proxy. It tunnels only to the hosts above. */
  proxyServer: string;
}

export function readStack(): BrowserSessionStack {
  const raw = process.env[STACK_ENVIRONMENT_VARIABLE];
  if (!raw) {
    throw new Error(
      `${STACK_ENVIRONMENT_VARIABLE} is not set. Run this suite with \`vp run test:e2e:browser-session\`, whose global setup starts the stack.`,
    );
  }
  return JSON.parse(raw) as BrowserSessionStack;
}
