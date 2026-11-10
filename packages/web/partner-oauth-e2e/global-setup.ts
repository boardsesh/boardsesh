import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startEdge, type Edge } from './edge';
import {
  API_HOST,
  SEED_OUTPUT_PREFIX,
  STACK_ENVIRONMENT_VARIABLE,
  WS_HOST,
  WWW_HOST,
  WWW_ORIGIN,
  type PartnerOAuthStack,
  type SeedResult,
} from './stack';

/**
 * Starts everything the partner journey runs against, the way it runs in
 * production but on this machine:
 *
 * - the dev database (`vp run db:up`, or the CI service), with two seeded
 *   accounts and one old tick (`database.ts`);
 * - the real backend entry point (`src/index.ts`) with partner OAuth in
 *   `allowlist` mode;
 * - the real www (`next dev`) with the same mode,
 *   the production `NEXTAUTH_URL`, and so the production cookie name and domain;
 * - the edge (`edge.ts`) that makes the browser and the app reach them as
 *   https://www.boardsesh.com, https://api.boardsesh.com and https://ws.boardsesh.com.
 *
 * Returns the teardown: stop both servers, close the edge, delete the seeded
 * accounts (their app, connection and ticks go with them).
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const WEB_DIRECTORY = resolve(REPO_ROOT, 'packages/web');
const BACKEND_DIRECTORY = resolve(REPO_ROOT, 'packages/backend');
const LOG_DIRECTORY = resolve(WEB_DIRECTORY, 'test-results/partner-oauth');

const BACKEND_READY_MS = 120_000;
/** `next dev` compiles each route on its first request; a cold compile of the auth pages takes a while. */
const WEB_READY_MS = 300_000;

type Environment = Record<string, string | undefined>;

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

function createCertificate(directory: string): { key: Buffer; cert: Buffer } {
  const keyPath = join(directory, 'edge-key.pem');
  const certificatePath = join(directory, 'edge-certificate.pem');
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
      `subjectAltName=DNS:${WWW_HOST},DNS:${API_HOST},DNS:${WS_HOST}`,
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certificatePath) };
}

/** `database.ts` under tsx, with the database URL and nothing secret. */
function runDatabaseStep(databaseUrl: string, args: string[]): string {
  return execFileSync('vp', ['exec', 'tsx', 'partner-oauth-e2e/database.ts', ...args], {
    cwd: WEB_DIRECTORY,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function startProcess(name: string, command: string, args: string[], cwd: string, environment: Environment) {
  const logFile = join(LOG_DIRECTORY, `${name}.log`);
  const log = createWriteStream(logFile, { flags: 'w' });
  // Its own process group, so teardown stops `vp exec`, the runtime it starts and any workers together.
  const child = spawn(command, args, {
    cwd,
    // Typed for the web app, where NODE_ENV is always set; a child here runs without one.
    env: environment as unknown as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return { name, child, logFile } satisfies ManagedProcess;
}

async function stopProcess({ child }: ManagedProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const processGroup = child.pid;
  const exited = once(child, 'exit');
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-processGroup, signal);
    } catch {
      // Already gone.
    }
  };
  signalGroup('SIGTERM');
  const forceKill = setTimeout(() => signalGroup('SIGKILL'), 15_000);
  await exited;
  clearTimeout(forceKill);
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

  // Refuses anything but a local database before it writes a row.
  const seedOutput = runDatabaseStep(databaseUrl, ['seed'])
    .split('\n')
    .find((line) => line.startsWith(SEED_OUTPUT_PREFIX));
  if (!seedOutput) throw new Error('The seed step printed no result.');
  const seeded = JSON.parse(seedOutput.slice(SEED_OUTPUT_PREFIX.length)) as SeedResult;

  mkdirSync(LOG_DIRECTORY, { recursive: true });
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-partner-e2e-'));
  const certificate = createCertificate(workDirectory);

  const [backendPort, webPort] = [await freePort(), await freePort()];
  const shared: Environment = {
    DATABASE_URL: databaseUrl,
    ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
    ...(devDatabase.BOARDSESH_DEV_DB_PLAINTEXT
      ? {
          BOARDSESH_DEV_DB_PLAINTEXT: devDatabase.BOARDSESH_DEV_DB_PLAINTEXT,
          BOARDSESH_DEV_DB_HOST: devDatabase.BOARDSESH_DEV_DB_HOST,
        }
      : {}),
    // One run's secret, shared by both services as in production.
    NEXTAUTH_SECRET: randomBytes(32).toString('base64url'),
    // Both services, in step: the web marks sign-ins `link_guarded` only while its own mode is on.
    PARTNER_OAUTH_MODE: 'allowlist',
    // Never production in Sentry, whatever else the environment looks like.
    SENTRY_ENVIRONMENT: 'partner-oauth-e2e',
  };
  const inherited: Environment = { ...process.env };
  delete inherited.NODE_ENV;
  delete inherited.PORT;

  const backend = startProcess('backend', 'vp', ['exec', 'tsx', 'src/index.ts'], BACKEND_DIRECTORY, {
    ...inherited,
    ...shared,
    PORT: String(backendPort),
    PARTNER_OAUTH_SECRETS: `1:${randomBytes(32).toString('base64url')}`,
    PARTNER_OAUTH_DEVELOPER_ALLOWLIST: seeded.developer.userId,
    BOARDSESH_WEB_URL: `http://127.0.0.1:${webPort}`,
    // As in packages/backend/.env.development: no background job families on a test run.
    BATCH_FAMILIES_DISABLED: 'all',
  });

  const backendGraphqlUrl = `ws://127.0.0.1:${backendPort}/graphql`;
  const web = startProcess(
    'web',
    'vp',
    ['exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(webPort), '--turbopack'],
    WEB_DIRECTORY,
    {
      ...inherited,
      ...shared,
      // The production origin: NextAuth then writes `__Secure-next-auth.session-token` for `.boardsesh.com`.
      NEXTAUTH_URL: WWW_ORIGIN,
      // The server half reaches the backend directly; the browser derives wss://ws.boardsesh.com from the host.
      BACKEND_INTERNAL_URL: backendGraphqlUrl,
      NEXT_PUBLIC_WS_URL: backendGraphqlUrl,
      // next dev refuses its dev resources to an origin it does not know.
      DEV_ALLOWED_ORIGINS: WWW_HOST,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  );
  const processes = [backend, web];

  let edge: Edge | undefined;
  const teardown = async () => {
    await Promise.all(processes.map(stopProcess));
    await edge?.close();
    if (process.env.PARTNER_OAUTH_E2E_KEEP_DATA !== '1') {
      runDatabaseStep(databaseUrl, ['cleanup', seeded.developer.userId, seeded.climber.userId]);
    }
    rmSync(workDirectory, { recursive: true, force: true });
  };

  try {
    edge = await startEdge({
      key: certificate.key,
      cert: certificate.cert,
      upstreams: { [WWW_HOST]: webPort, [API_HOST]: backendPort, [WS_HOST]: backendPort },
      // www's Sentry tunnel and the backend's PostHog proxy forward to the real services.
      refusedPathPrefixes: { [WWW_HOST]: ['/monitoring'], [API_HOST]: ['/api/posthog'], [WS_HOST]: ['/api/posthog'] },
    });

    await waitUntil(
      'the backend',
      async () => (await probe(backendPort, '/health', WS_HOST, 5_000)) === 200,
      BACKEND_READY_MS,
      processes,
    );
    // Discovery answers only when the backend read `allowlist`: proof the mode took.
    const discovery = await probe(backendPort, '/.well-known/oauth-authorization-server/api/auth', API_HOST);
    if (discovery !== 200) {
      throw new Error(`Partner discovery answered ${discovery}; the backend is not serving partner OAuth.`);
    }

    await waitUntil(
      'www',
      async () => (await probe(webPort, '/oauth/sign-in', WWW_HOST)) === 200,
      WEB_READY_MS,
      processes,
    );
    // Compile what the journey visits before the test's clock starts.
    for (const path of [
      '/oauth/consent',
      '/auth/login',
      '/api/auth/csrf',
      '/api/auth/session',
      '/api/internal/ws-auth',
    ]) {
      await probe(webPort, path, WWW_HOST);
    }
  } catch (error) {
    await teardown();
    throw error;
  }

  const stack: PartnerOAuthStack = {
    proxyServer: edge.proxyServer,
    appEdgePort: edge.appPort,
    certificatePem: certificate.cert.toString('utf8'),
    ...seeded,
  };
  process.env[STACK_ENVIRONMENT_VARIABLE] = JSON.stringify(stack);
  return teardown;
}
