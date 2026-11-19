/**
 * What the global setup hands the spec: where the stack it started listens, and
 * the accounts and climb it seeded. Passed as JSON in one environment variable,
 * because Playwright starts its workers after the global setup and they inherit
 * its environment.
 */

export const STACK_ENVIRONMENT_VARIABLE = 'PARTNER_OAUTH_E2E_STACK';
/**
 * The developer terms version the e2e backend publishes. The shipped version
 * may be a draft, and the backend registers no app against draft terms.
 */
export const E2E_DEVELOPER_TERMS_VERSION = 'partner-e2e-terms-1';
/** The line `database.ts seed` prints its result on. */
export const SEED_OUTPUT_PREFIX = 'PARTNER_OAUTH_E2E_SEED=';

/** The three production host names the edge answers for. Nothing else leaves the machine. */
export const WWW_HOST = 'www.boardsesh.com';
export const API_HOST = 'api.boardsesh.com';
export const WS_HOST = 'ws.boardsesh.com';
/** Reserved test domains: served only by the owned callback server behind the proxy. */
export const PUBLIC_APP_HOST = 'public.partner.test';
export const CONFIDENTIAL_APP_HOST = 'confidential.partner.test';
export const UNREGISTERED_APP_HOST = 'unregistered.partner.test';
export const PARTNER_SCENARIOS = [
  'public-web',
  'confidential-web',
  'native-scheme',
  'loopback',
  'cors',
  'hydration',
  'journey',
] as const;
export type PartnerScenario = (typeof PARTNER_SCENARIOS)[number];
export const PARTNER_TEST_HOSTS = [PUBLIC_APP_HOST, CONFIDENTIAL_APP_HOST, UNREGISTERED_APP_HOST] as const;
export const PUBLIC_APP_ORIGIN = `https://${PUBLIC_APP_HOST}`;
export const CONFIDENTIAL_APP_ORIGIN = `https://${CONFIDENTIAL_APP_HOST}`;
export const UNREGISTERED_APP_ORIGIN = `https://${UNREGISTERED_APP_HOST}`;

export const WWW_ORIGIN = `https://${WWW_HOST}`;
export const ISSUER = `https://${API_HOST}/api/auth`;
export const RESOURCE = `https://${API_HOST}/v1`;
export const GRAPHQL_URL = `https://${WS_HOST}/graphql`;

export interface SeededAccount {
  userId: string;
  email: string;
  password: string;
  name: string;
}

export interface PartnerOAuthStack {
  /** The browser's HTTP proxy. It tunnels only to the fixed app and test hosts above. */
  proxyServer: string;
  /** Where the partner app's server reaches the edge directly, as a backend calling api.boardsesh.com would. */
  appEdgePort: number;
  /** The edge's self-signed certificate, which the app's server trusts. */
  certificatePem: string;
  developer: SeededAccount;
  climber: SeededAccount;
  /** A listed Kilter climb from the dev database, for the tick the climber logs. */
  climb: { boardType: string; uuid: string; name: string; layoutId: number };
  /** A tick seeded as old history, so the snapshot has something from before the connection. */
  historyTickId: string;
}

export type SeedResult = Pick<PartnerOAuthStack, 'developer' | 'climber' | 'climb' | 'historyTickId'>;
export type SerializedPartnerOAuthStack = Omit<PartnerOAuthStack, keyof SeedResult> & {
  /** Each engine and scenario owns its logbook, accounts, rate buckets and connections. */
  seeds: Record<string, SeedResult>;
};

export function readStack(browserName: string, scenario: PartnerScenario): PartnerOAuthStack {
  const raw = process.env[STACK_ENVIRONMENT_VARIABLE];
  if (!raw) {
    throw new Error(
      `${STACK_ENVIRONMENT_VARIABLE} is not set. Run this suite with \`vp run test:e2e:partner-oauth\`, whose global setup starts the stack.`,
    );
  }
  const serialized = JSON.parse(raw) as SerializedPartnerOAuthStack;
  const seed = serialized.seeds[`${browserName}:${scenario}`];
  if (!seed) throw new Error(`No owned partner fixture for ${browserName}:${scenario}`);
  return { ...serialized, ...seed };
}
