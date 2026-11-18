import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { startEdge, type Edge } from '../../partner-oauth-e2e/edge';
import {
  assertLocalOnly,
  inheritedEnvironment,
  serverEnvironment,
  type Environment,
  type EnvironmentFile,
} from '../../partner-oauth-e2e/server-environment';
import { startProbeServer } from './probe-server';
import { startStaticServer } from './static-server';
import {
  APP_EXPORT_ENVIRONMENT_VARIABLE,
  APP_HOST,
  APP_ORIGIN,
  BACKEND_ORIGIN,
  COOKIE_DOMAIN,
  GRAPHQL_URL,
  PROBE_HOST_ONE,
  PROBE_HOST_TWO,
  STACK_ENVIRONMENT_VARIABLE,
  WS_HOST,
  WWW_HOST,
  WWW_ORIGIN,
  type BrowserSessionStack,
} from './stack';

/**
 * Starts everything the browser-session specs run against, the way production
 * runs it but on this machine:
 *
 * - the dev database (`vp run db:up`, or the CI service) with its seeded test user;
 * - the real backend entry point (`src/index.ts`);
 * - the real www (`next dev`) with the production cookie shape: a
 *   `__Secure-` session cookie with `Domain=.boardsesh.test` (AUTH_COOKIE_DOMAIN);
 * - the standalone Expo web export (baseUrl `/`, as app.boardsesh.com serves it),
 *   built by `scripts/browser-session-e2e.ts` with these three origins baked in;
 * - an edge (`partner-oauth-e2e/edge.ts`, shared with the partner journey) that
 *   terminates TLS and makes the browsers reach https://www.boardsesh.test,
 *   https://app.boardsesh.test and https://ws.boardsesh.test through a proxy.
 *
 * `AUTH_BROWSER_SESSION_MODE` is left unset, so www runs NextAuth, today's mode.
 * It is forwarded only when the caller sets it, for the Phase B specs.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const WEB_DIRECTORY = resolve(REPO_ROOT, 'packages/web');
const BACKEND_DIRECTORY = resolve(REPO_ROOT, 'packages/backend');
const LOG_DIRECTORY = resolve(WEB_DIRECTORY, 'test-results/browser-session');
const WATCHDOG = resolve(__dirname, '../../partner-oauth-e2e/watchdog.mjs');

const BACKEND_READY_MS = 120_000;
/** `next dev` compiles each route on its first request. */
const WEB_READY_MS = 300_000;

interface ManagedProcess {
  name: string;
  child: ChildProcess;
  logFile: string;
}

function readEnvironmentFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/**
 * One self-signed certificate for every host. The key lives only in a run
 * directory under the ignored `.boardsesh/`, and teardown deletes it.
 */
function createCertificate(directory: string): { key: Buffer; cert: Buffer } {
  const keyPath = join(directory, 'edge-key.pem');
  const certificatePath = join(directory, 'edge-certificate.pem');
  const hosts = [WWW_HOST, APP_HOST, WS_HOST, PROBE_HOST_ONE, PROBE_HOST_TWO];
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${WWW_HOST}`,
      '-addext',
      `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(',')}`,
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certificatePath) };
}

/**
 * Starts a server under `watchdog.mjs`, as the leader of its own process group,
 * so a killed test run never leaves `next dev` or the backend behind.
 */
function startProcess(name: string, command: string, args: string[], cwd: string, environment: Environment) {
  const logFile = join(LOG_DIRECTORY, `${name}.log`);
  const log = createWriteStream(logFile, { flags: 'w' });
  const child = spawn(process.execPath, [WATCHDOG, String(process.pid), command, ...args], {
    cwd,
    env: environment as unknown as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return { name, child, logFile } satisfies ManagedProcess;
}

function signalGroup(processGroup: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroup, signal);
  } catch {
    // The group is already empty.
  }
}

async function stopProcess({ child }: ManagedProcess): Promise<void> {
  if (child.pid === undefined) return;
  const processGroup = child.pid;
  const running = child.exitCode === null && child.signalCode === null;
  const exited = running ? once(child, 'exit') : Promise.resolve();
  signalGroup(processGroup, 'SIGTERM');
  const forceKill = setTimeout(() => signalGroup(processGroup, 'SIGKILL'), 15_000);
  await exited;
  clearTimeout(forceKill);
  signalGroup(processGroup, 'SIGKILL');
}

function logTail(managed: ManagedProcess): string {
  try {
    return readFileSync(managed.logFile, 'utf8').split('\n').slice(-40).join('\n');
  } catch {
    return '(no log)';
  }
}

/** One request straight to a local server, as the edge would send it. Resolves with the status. */
function probe(port: number, path: string, host: string, timeoutMs = 180_000): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        agent: false,
        timeout: timeoutMs,
        headers: { Host: host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.0.1' },
      },
      (incoming) => {
        incoming.resume();
        incoming.on('end', () => resolveStatus(incoming.statusCode ?? 0));
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error(`${host}${path} took over ${timeoutMs} ms`)));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function waitUntil(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  processes: ManagedProcess[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const managed of processes) {
      if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
        throw new Error(`${managed.name} exited while waiting for ${description}. Last lines:\n${logTail(managed)}`);
      }
    }
    if (await check().catch(() => false)) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for ${description}.\n` +
      processes.map((managed) => `--- ${managed.name} ---\n${logTail(managed)}`).join('\n'),
  );
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

  mkdirSync(LOG_DIRECTORY, { recursive: true });
  const runsDirectory = resolve(REPO_ROOT, '.boardsesh/browser-session');
  mkdirSync(runsDirectory, { recursive: true });
  const workDirectory = mkdtempSync(join(runsDirectory, 'run-'));
  const processes: ManagedProcess[] = [];
  const servers: Server[] = [];
  let edge: Edge | undefined;
  const teardown = async () => {
    await Promise.all(processes.map(stopProcess));
    await edge?.close();
    await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
    rmSync(workDirectory, { recursive: true, force: true });
  };

  try {
    const certificate = createCertificate(workDirectory);
    const [backendPort, webPort] = [await freePort(), await freePort()];
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
      NEXTAUTH_SECRET: randomBytes(32).toString('base64url'),
      // Never production in Sentry, whatever else the environment looks like.
      SENTRY_ENVIRONMENT: 'browser-session-e2e',
      // No outside service, even if an environment file names one: blank wins over a file.
      READ_REPLICA_URL: '',
      SMTP_HOST: '',
      // Today's mode (NextAuth) unless a caller asks for another one.
      ...(process.env.AUTH_BROWSER_SESSION_MODE
        ? { AUTH_BROWSER_SESSION_MODE: process.env.AUTH_BROWSER_SESSION_MODE }
        : {}),
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
      },
      // What `next dev` loads, first one wins.
      ['.env.development.local', '.env.local', '.env.development', '.env'].map((name) => ({
        path: join(WEB_DIRECTORY, name),
        override: false,
      })),
    );
    assertLocalOnly('backend', backendEnvironment);
    assertLocalOnly('web server', webEnvironment);

    processes.push(
      startProcess('backend', 'vp', ['exec', 'tsx', 'src/index.ts'], BACKEND_DIRECTORY, backendEnvironment.environment),
      startProcess(
        'web',
        'vp',
        ['exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(webPort), '--turbopack'],
        WEB_DIRECTORY,
        webEnvironment.environment,
      ),
    );

    const staticApp = await startStaticServer(appExport);
    const probeApp = await startProbeServer();
    servers.push(staticApp.server, probeApp.server);

    edge = await startEdge({
      key: certificate.key,
      cert: certificate.cert,
      upstreams: {
        [WWW_HOST]: webPort,
        [WS_HOST]: backendPort,
        [APP_HOST]: staticApp.port,
        [PROBE_HOST_ONE]: probeApp.port,
        [PROBE_HOST_TWO]: probeApp.port,
      },
      // www's Sentry tunnel and the backend's PostHog proxy forward to the real services.
      refusedPathPrefixes: { [WWW_HOST]: ['/monitoring'], [WS_HOST]: ['/api/posthog'] },
    });

    await waitUntil(
      'the backend',
      async () => (await probe(backendPort, '/health', WS_HOST, 5_000)) === 200,
      BACKEND_READY_MS,
      processes,
    );
    await waitUntil(
      'www',
      async () => (await probe(webPort, '/auth/login', WWW_HOST)) === 200,
      WEB_READY_MS,
      processes,
    );
    // Compile what the specs visit before the test's clock starts.
    for (const path of ['/settings', '/auth/signout', '/api/auth/csrf', '/api/auth/session', '/api/internal/ws-auth']) {
      await probe(webPort, path, WWW_HOST);
    }

    const stack: BrowserSessionStack = { proxyServer: edge.proxyServer };
    process.env[STACK_ENVIRONMENT_VARIABLE] = JSON.stringify(stack);
    console.info(`[browser-session] stack up: ${WWW_ORIGIN} ${APP_ORIGIN} ${BACKEND_ORIGIN}`);
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
