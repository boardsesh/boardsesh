import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { startAppleOidcFixture } from '../../auth-proofs/apple-oidc-fixture';
import { startGoogleOidcFixture } from '../../auth-proofs/google-oidc-fixture';
import { startEdge, type Edge } from '../../partner-oauth-e2e/edge';
import {
  assertLocalOnly,
  inheritedEnvironment,
  serverEnvironment,
  type Environment,
  type EnvironmentFile,
} from '../../partner-oauth-e2e/server-environment';
import { startBackendRelay } from './backend-relay';
import { betterAuthEnvironments, type BetterAuthDatabase } from './better-auth-environment';
import { createCertificate } from './certificate';
import { harnessRetryBudgetError } from './harness-retries';
import { ResponseHolds, SetCookieLog, startControlServer } from './control-server';
import { startMailSink, type MailSink } from './mail-sink';
import { freePort, readEnvironmentFile } from './processes';
import { startProbeServer } from './probe-server';
import { backendReadiness, ServerSet, webReadiness, type ServerSpec } from './servers';
import { startStaticServer } from './static-server';
import {
  ACCOUNT_ID_PREFIX,
  APP_EXPORT_ENVIRONMENT_VARIABLE,
  APP_HOST,
  APP_ORIGIN,
  APPLE_STAND_IN_HOST,
  APPLE_STAND_IN_ORIGIN,
  APPLE_STAND_IN_CLIENT,
  BACKEND_ORIGIN,
  GOOGLE_STAND_IN_CLIENT,
  GOOGLE_STAND_IN_HOST,
  GOOGLE_STAND_IN_ORIGIN,
  COOKIE_DOMAIN,
  GRAPHQL_URL,
  PROBE_HOST_ONE,
  PROBE_HOST_TWO,
  SEED_OUTPUT_PREFIX,
  STACK_ENVIRONMENT_VARIABLE,
  WS_HOST,
  WWW_HOST,
  WWW_ORIGIN,
  type BrowserSessionStack,
  type SeededAccount,
  type WwwMode,
} from './stack';

/**
 * Starts everything the browser-session specs run against, the way production
 * runs it but on this machine:
 *
 * - the dev database (`vp run db:up`, or the CI service) with its seeded test user;
 * - the real backend entry point (`src/index.ts`);
 * - the real www (`next dev`, or `next build` and `next start` when
 *   BROWSER_SESSION_E2E_WWW=production) with the production cookie shape: a
 *   `__Secure-` session cookie with `Domain=.boardsesh.test` (AUTH_COOKIE_DOMAIN);
 * - the standalone Expo web export (baseUrl `/`, as app.boardsesh.com serves it),
 *   built by `scripts/browser-session-e2e.ts` with these three origins baked in;
 * - an edge (`partner-oauth-e2e/edge.ts`, shared with the partner journey) that
 *   terminates TLS and makes the browsers reach https://www.boardsesh.test,
 *   https://app.boardsesh.test and https://ws.boardsesh.test through a proxy.
 *
 * Two accounts are seeded for the specs (the dev database's test user and one
 * made for this run), the edge logs every response's Set-Cookie names, and a
 * control server lets a spec restart the backend and www with a changed
 * environment. All three reach the workers through the stack JSON.
 *
 * `AUTH_BROWSER_SESSION_MODE` is left unset, so www runs NextAuth, today's mode.
 * It is forwarded only when the caller sets it, for the Phase B specs.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const WEB_DIRECTORY = resolve(REPO_ROOT, 'packages/web');
const BACKEND_DIRECTORY = resolve(REPO_ROOT, 'packages/backend');
const LOG_DIRECTORY = resolve(WEB_DIRECTORY, 'test-results/browser-session');

/** A run directory this old belongs to a run that died without its teardown. */
const STALE_RUN_DIRECTORY_MS = 60 * 60 * 1000;
const WWW_BUILD_MS = 20 * 60 * 1000;

/** The backend fixture that prepares the database for `better-auth` (run from the backend package). */
const BETTER_AUTH_DATABASE_STEP = {
  cwd: BACKEND_DIRECTORY,
  script: 'src/auth/authority/__tests__/fixtures/browser-session-e2e-database.ts',
};

/** A harness script under tsx, with the database URL and nothing secret. */
function runDatabaseStep(
  databaseUrl: string,
  args: string[],
  { cwd, script } = { cwd: WEB_DIRECTORY, script: 'e2e/browser-session/database.ts' },
): string {
  return execFileSync('vp', ['exec', 'tsx', script, ...args], {
    cwd,
    env: {
      ...inheritedEnvironment(process.env),
      DATABASE_URL: databaseUrl,
      TEST_USER_EMAIL: process.env.TEST_USER_EMAIL,
      TEST_USER_PASSWORD: process.env.TEST_USER_PASSWORD,
      BROWSER_SESSION_E2E_PREPARE_DATABASE: process.env.BROWSER_SESSION_E2E_PREPARE_DATABASE,
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** The JSON a harness script printed after SEED_OUTPUT_PREFIX. */
function printedResult<T>(output: string): T {
  const line = output.split('\n').find((candidate) => candidate.startsWith(SEED_OUTPUT_PREFIX));
  if (!line) throw new Error('The database step printed no result.');
  return JSON.parse(line.slice(SEED_OUTPUT_PREFIX.length)) as T;
}

/** `legacy` (unset) unless the caller asks for `better-auth`; anything else stops the run. */
function readBrowserSessionMode(): 'legacy' | 'better-auth' {
  const requested = process.env.AUTH_BROWSER_SESSION_MODE ?? '';
  if (requested === '' || requested === 'legacy') return 'legacy';
  if (requested === 'better-auth') return requested;
  throw new Error('AUTH_BROWSER_SESSION_MODE must be legacy or better-auth for this run.');
}

/**
 * Deletes `run-*` directories left by runs that were killed before their
 * teardown: each holds a certificate key. Only old ones, so a run in another
 * checkout of the same machine keeps its own. The Expo export beside them stays.
 */
function sweepStaleRunDirectories(runsDirectory: string): void {
  for (const entry of readdirSync(runsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const directory = join(runsDirectory, entry.name);
    if (Date.now() - statSync(directory).mtimeMs > STALE_RUN_DIRECTORY_MS) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function readWwwMode(): WwwMode {
  const requested = process.env.BROWSER_SESSION_E2E_WWW ?? 'dev';
  if (requested !== 'dev' && requested !== 'production') {
    throw new Error(`BROWSER_SESSION_E2E_WWW must be dev or production, not ${requested}.`);
  }
  return requested;
}

/** `next build` as the web package's build script runs it, with the environment the server will run with. */
function buildWww(environment: Environment): void {
  console.info('[browser-session] building www (next build) for BROWSER_SESSION_E2E_WWW=production');
  for (const command of [
    ['node', 'scripts/copy-maplibre-worker.mjs'],
    ['vp', 'exec', 'tsx', 'scripts/generate-openapi.ts'],
    ['vp', 'exec', 'next', 'build'],
  ]) {
    execFileSync(command[0] as string, command.slice(1), {
      cwd: WEB_DIRECTORY,
      env: environment as unknown as NodeJS.ProcessEnv,
      stdio: 'inherit',
      timeout: WWW_BUILD_MS,
    });
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const devDatabase = readEnvironmentFile(join(REPO_ROOT, '.boardsesh/dev-db.env'));
  const databaseUrl = process.env.DATABASE_URL || devDatabase.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('No DATABASE_URL. Start the dev database with `vp run db:up` first.');
  }
  const redisUrl = process.env.REDIS_URL || devDatabase.REDIS_URL || '';
  const appExport = process.env[APP_EXPORT_ENVIRONMENT_VARIABLE];
  if (!appExport) {
    throw new Error(
      `${APP_EXPORT_ENVIRONMENT_VARIABLE} is not set. Run this suite with \`vp run test:e2e:browser-session\`, which builds the Expo web export first.`,
    );
  }
  const wwwMode = readWwwMode();
  const browserSessionMode = readBrowserSessionMode();

  mkdirSync(LOG_DIRECTORY, { recursive: true });
  for (const name of ['backend.log', 'web.log']) rmSync(join(LOG_DIRECTORY, name), { force: true });
  const runsDirectory = resolve(REPO_ROOT, '.boardsesh/browser-session');
  mkdirSync(runsDirectory, { recursive: true });
  sweepStaleRunDirectories(runsDirectory);
  const workDirectory = mkdtempSync(join(runsDirectory, 'run-'));
  // Every account this run makes, B and each test's own, shares one prefix, so teardown removes them together.
  const runAccountPrefix = `${ACCOUNT_ID_PREFIX}${randomUUID().slice(0, 8)}-`;
  const accountBId = `${runAccountPrefix}${randomUUID()}`;
  const servers: Server[] = [];
  let serverSet: ServerSet | undefined;
  let edge: Edge | undefined;
  let accountBSeeded = false;
  let mailSink: MailSink | undefined;
  let releaseHolds: () => void = () => undefined;
  let apple: Awaited<ReturnType<typeof startAppleOidcFixture>> | undefined;
  let google: Awaited<ReturnType<typeof startGoogleOidcFixture>> | undefined;
  const teardown = async () => {
    releaseHolds();
    await apple?.close();
    await google?.close();
    await serverSet?.shutdown();
    await edge?.close();
    await mailSink?.close();
    // Kept-alive connections (www's to the relay, a worker's to the control server) would hold close() open.
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      ),
    );
    if (accountBSeeded) runDatabaseStep(databaseUrl, ['cleanup', `${runAccountPrefix}%`]);
    rmSync(workDirectory, { recursive: true, force: true });
    const overBudget = harnessRetryBudgetError();
    if (overBudget) throw overBudget;
  };

  try {
    const certificate = createCertificate(workDirectory);
    // Sign in with Apple, played by a stand-in: its page on its own site through the edge, its token and
    // key endpoints on loopback for www (auth-proofs/apple-oidc-fixture.ts).
    apple = await startAppleOidcFixture({ ...APPLE_STAND_IN_CLIENT, browserOrigin: APPLE_STAND_IN_ORIGIN });
    google = await startGoogleOidcFixture(GOOGLE_STAND_IN_CLIENT.clientId, { browserOrigin: GOOGLE_STAND_IN_ORIGIN });
    const [backendPort, webPort] = [await freePort(), await freePort()];
    const backendRelay = await startBackendRelay(certificate, backendPort);
    servers.push(backendRelay.server);
    const nextAuthSecret = randomBytes(32).toString('base64url');
    const shared: Environment = {
      ...inheritedEnvironment(process.env),
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      ...(devDatabase.BOARDSESH_DEV_DB_PLAINTEXT
        ? {
            BOARDSESH_DEV_DB_PLAINTEXT: devDatabase.BOARDSESH_DEV_DB_PLAINTEXT,
            BOARDSESH_DEV_DB_HOST: devDatabase.BOARDSESH_DEV_DB_HOST,
          }
        : {}),
      // One run's secret, shared by both services as in production.
      NEXTAUTH_SECRET: nextAuthSecret,
      // Never production in Sentry, whatever else the environment looks like.
      SENTRY_ENVIRONMENT: 'browser-session-e2e',
      // Apple configured on both services: www's provider and the backend's methods.
      APPLE_ID: APPLE_STAND_IN_CLIENT.clientId,
      APPLE_SECRET: APPLE_STAND_IN_CLIENT.clientSecret,
      // Google likewise. With no CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE the backend verifies no
      // Google token, so a Google sign-in here is carried (never fresh).
      GOOGLE_CLIENT_ID: GOOGLE_STAND_IN_CLIENT.clientId,
      GOOGLE_CLIENT_SECRET: GOOGLE_STAND_IN_CLIENT.clientSecret,
      // No outside service, even if an environment file names one: blank wins over a file.
      READ_REPLICA_URL: '',
      SMTP_HOST: '',
    };

    const backendEnvironment = serverEnvironment(
      {
        ...shared,
        PORT: String(backendPort),
        // CORS and the WebSocket origin check: www and the app subdomain, as in production.
        BOARDSESH_URL: WWW_ORIGIN,
        APP_ORIGIN,
        BOARDSESH_WEB_URL: `http://127.0.0.1:${webPort}`,
        // As in packages/backend/.env.development: no background job families on a test run.
        BATCH_FAMILIES_DISABLED: 'all',
      },
      // What src/instrument.ts loads: `.env`, the generated dev-db file, then the override file.
      [
        { path: join(BACKEND_DIRECTORY, '.env'), override: false },
        { path: join(REPO_ROOT, '.boardsesh/dev-db.env'), override: false },
        { path: join(BACKEND_DIRECTORY, '.env.development.local'), override: true },
      ] satisfies EnvironmentFile[],
    );
    const backendGraphqlUrl = `ws://127.0.0.1:${backendPort}/graphql`;
    const webEnvironment = serverEnvironment(
      {
        ...shared,
        // An https origin: NextAuth then writes `__Secure-next-auth.session-token`.
        NEXTAUTH_URL: WWW_ORIGIN,
        // Any call NextAuth makes to itself stays on this machine.
        NEXTAUTH_URL_INTERNAL: `http://127.0.0.1:${webPort}`,
        // The existing explicit override (secure-cookies.ts): the parent domain, as `.boardsesh.com` in production.
        AUTH_COOKIE_DOMAIN: COOKIE_DOMAIN,
        // www's credentialed CORS and sign-in redirects trust this one app origin.
        NEXT_PUBLIC_APP_URL: APP_ORIGIN,
        // The server half reaches the backend directly; the browser uses the public WebSocket URL.
        BACKEND_INTERNAL_URL: backendGraphqlUrl,
        NEXT_PUBLIC_WS_URL: GRAPHQL_URL,
        // next dev refuses its dev resources to an origin it does not know.
        DEV_ALLOWED_ORIGINS: WWW_HOST,
        NEXT_TELEMETRY_DISABLED: '1',
        // www's Apple provider reads the stand-in's discovery document (oidc-stand-in.server.ts).
        BOARDSESH_E2E_APPLE_OIDC_WELL_KNOWN: apple.discoveryUrl,
        BOARDSESH_E2E_GOOGLE_OIDC_WELL_KNOWN: google.discoveryUrl,
      },
      // What `next dev` and `next start` load, first one wins.
      (wwwMode === 'production'
        ? ['.env.production.local', '.env.local', '.env.production', '.env']
        : ['.env.development.local', '.env.local', '.env.development', '.env']
      ).map((name) => ({ path: join(WEB_DIRECTORY, name), override: false })),
    );
    assertLocalOnly('backend', backendEnvironment);
    assertLocalOnly('web server', webEnvironment);

    // Account A is the dev database's test user; account B is made for this run.
    accountBSeeded = true;
    const accounts = printedResult<{ accountA: SeededAccount; accountB: SeededAccount }>(
      runDatabaseStep(databaseUrl, ['seed', accountBId]),
    );

    // `better-auth`: the database it needs, then every precondition both services check.
    if (browserSessionMode === 'better-auth') {
      const database = printedResult<BetterAuthDatabase>(runDatabaseStep(databaseUrl, [], BETTER_AUTH_DATABASE_STEP));
      const betterAuth = betterAuthEnvironments(database, {
        backendRelayOrigin: backendRelay.origin,
        certificatePath: certificate.certificatePath,
      });
      Object.assign(backendEnvironment.environment, betterAuth.backend);
      Object.assign(webEnvironment.environment, betterAuth.web);
      // www's shared mailer sends the first-password link here, over TLS with the run's certificate.
      mailSink = await startMailSink(certificate, {
        user: 'browser-session-e2e',
        password: randomBytes(18).toString('base64url'),
      });
      Object.assign(webEnvironment.environment, {
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(mailSink.port),
        SMTP_USER: mailSink.user,
        SMTP_PASSWORD: mailSink.password,
      });
      assertLocalOnly('backend', backendEnvironment);
      assertLocalOnly('web server', webEnvironment);
    }

    if (wwwMode === 'production') buildWww(webEnvironment.environment);

    const specs: ServerSpec[] = [
      {
        name: 'backend',
        command: 'vp',
        args: ['exec', 'tsx', 'src/index.ts'],
        cwd: BACKEND_DIRECTORY,
        port: backendPort,
        environment: backendEnvironment.environment,
        ...backendReadiness(),
      },
      {
        name: 'web',
        command: 'vp',
        args:
          wwwMode === 'production'
            ? ['exec', 'next', 'start', '--hostname', '127.0.0.1', '--port', String(webPort)]
            : ['exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(webPort), '--turbopack'],
        cwd: WEB_DIRECTORY,
        port: webPort,
        environment: webEnvironment.environment,
        ...webReadiness(),
      },
    ];
    serverSet = new ServerSet(specs, LOG_DIRECTORY);

    const staticApp = await startStaticServer(appExport);
    const probeApp = await startProbeServer();
    servers.push(staticApp.server, probeApp.server);

    const setCookieLog = new SetCookieLog();
    const responseHolds = new ResponseHolds();
    releaseHolds = () => responseHolds.releaseAll();
    edge = await startEdge({
      key: certificate.key,
      cert: certificate.cert,
      upstreams: {
        [WWW_HOST]: webPort,
        [WS_HOST]: backendPort,
        [APP_HOST]: staticApp.port,
        [PROBE_HOST_ONE]: probeApp.port,
        [PROBE_HOST_TWO]: probeApp.port,
        [APPLE_STAND_IN_HOST]: apple.port,
        [GOOGLE_STAND_IN_HOST]: google.port,
      },
      // www's Sentry tunnel and the backend's PostHog proxy forward to the real services.
      refusedPathPrefixes: { [WWW_HOST]: ['/monitoring'], [WS_HOST]: ['/api/posthog'] },
      onResponse: (observation) => setCookieLog.observe(observation),
      holdResponse: (request) => responseHolds.take(request),
    });
    const control = await startControlServer(setCookieLog, serverSet, mailSink?.messages ?? [], responseHolds);
    servers.push(control.server);

    await serverSet.start();

    const stack: BrowserSessionStack = {
      proxyServer: edge.proxyServer,
      accounts,
      nextAuthSecret,
      wwwMode,
      browserSessionMode,
      databaseUrl,
      runAccountPrefix,
      control: { url: control.url, token: control.token },
    };
    process.env[STACK_ENVIRONMENT_VARIABLE] = JSON.stringify(stack);
    console.info(
      `[browser-session] stack up (www: ${wwwMode}, mode: ${browserSessionMode}): ${WWW_ORIGIN} ${APP_ORIGIN} ${BACKEND_ORIGIN}`,
    );
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
