import { randomBytes } from 'node:crypto';
import type { Environment } from '../../partner-oauth-e2e/server-environment';
import { APP_ORIGIN, BACKEND_ORIGIN, WWW_ORIGIN } from './stack';

/**
 * Every variable `AUTH_BROWSER_SESSION_MODE=better-auth` checks before it
 * serves a browser session (#7596 B7b), read from the two checks themselves:
 * `assertBetterAuthPreconditions` in packages/backend/src/auth/authority/
 * browser-session-mode.ts and `betterAuthPreconditions` in
 * packages/web/app/lib/auth/browser-session-mode.server.ts. Nothing here forces
 * a check to pass: each value is one production would set.
 *
 * The one test-only variable is BOARDSESH_E2E_BROWSER_SESSION_CUTOVER=allow,
 * which empties both cutover blocker lists on these `.test` origins only
 * (`cutoverBlockersInEffect` in each of the two modules).
 *
 * The secrets are made for this run, at least 32 bytes each and all different,
 * as both checks require. They guard a throwaway database and die with the run.
 */

export interface BetterAuthDatabase {
  projectionId: string;
  writerEpoch: number;
  identityDatabaseUrl: string;
  contract: string;
}

export interface BetterAuthEnvironments {
  backend: Environment;
  web: Environment;
}

const secret = () => randomBytes(32).toString('base64url');

export function betterAuthEnvironments(
  database: BetterAuthDatabase,
  { backendRelayOrigin, certificatePath }: { backendRelayOrigin: string; certificatePath: string },
): BetterAuthEnvironments {
  const rpcSecret = secret();
  const cookieSecret = secret();
  const shared: Environment = {
    AUTH_BROWSER_SESSION_MODE: 'better-auth',
    BOARDSESH_E2E_BROWSER_SESSION_CUTOVER: 'allow',
    CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
    CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
    CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
    CURRENT_STORE_SET_PASSWORD_MODE: 'backend-staging',
    CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
    // Settings' provider link, unlink and reauthentication, and a first password (B5e1, B5e2).
    CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
    CURRENT_STORE_FIRST_PASSWORD_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    AUTH_BROWSER_SESSION_COOKIE_SECRET: cookieSecret,
    // The backend's `verification.required` and www's own switch, from one value.
    EMAIL_VERIFICATION_ENABLED: 'false',
    // Not a secret any check compares against here; empty so a file cannot supply one.
    CRON_SECRET: '',
  };
  return {
    backend: {
      ...shared,
      // The backend's own public origin, which the e2e seam reads with BOARDSESH_URL.
      BACKEND_PUBLIC_URL: BACKEND_ORIGIN,
      BOARDSESH_URL: WWW_ORIGIN,
      APP_ORIGIN,
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      DEBUG_SQL: 'false',
      CURRENT_STORE_AUTH_PROJECTION_ID: database.projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: String(database.writerEpoch),
      CURRENT_STORE_DELETED_EMAIL_KEY: secret(),
      AUTH_BROWSER_ACCESS_TOKEN_SECRET: secret(),
      AUTH_BRIDGE_TOKEN_SECRET: secret(),
      // Cutover plus 30 days, as the runbook sets it (at most 45).
      AUTH_LEGACY_BRIDGE_UNTIL: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      // The private web commands open their database only through this LOGIN.
      AUTH_IDENTITY_DATABASE_URL: database.identityDatabaseUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: database.contract,
    },
    web: {
      ...shared,
      // https even to a loopback backend: the production build accepts nothing else.
      CURRENT_STORE_AUTH_BACKEND_ORIGIN: backendRelayOrigin,
      NODE_EXTRA_CA_CERTS: certificatePath,
    },
  };
}
