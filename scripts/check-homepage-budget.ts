import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { HOMEPAGE_GZIP_BUDGET_BYTES, WWW_CHECKS, type SmokeResponse } from './production-smoke';

const DEADLINE_MS = 60_000;
const STARTUP_MS = 20_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const BLOCKED_CONNECTION = 'HOMEPAGE_BUDGET_BLOCKED_CONNECTION';
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&#x27;': "'",
  '&#x2f;': '/',
};
const NORMAL_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const HOMEPAGE_FIXTURE_ROWS = 20;

export function createHomepageFixture(token = 'homepage-budget-fixture-v1') {
  const recentBetaLinks = Array.from({ length: HOMEPAGE_FIXTURE_ROWS }, (_, index) => {
    const digest = createHash('sha256').update(`${token}:${index}`).digest('hex');
    const climbUuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    return {
      climbName: `Budget fixture climb ${index + 1}`,
      boardType: 'kilter',
      layoutId: 1,
      betaLink: {
        climbUuid,
        link: `https://www.instagram.com/reel/${digest.slice(0, 12)}/`,
        foreignUsername: `budget_${token.slice(0, 8)}_row${String(index + 1).padStart(2, '0')}_end`,
        angle: 40,
        thumbnail: `http://127.0.0.1/budget-fixture/${climbUuid}.jpg`,
        isListed: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        tickUuid: null,
        boardId: null,
      },
    };
  });
  return {
    recentBetaLinks,
    communityStats: { climbersLast30Days: 123_400, litLast30Days: 5_678_000, computedAt: '2026-01-01T00:00:00.000Z' },
    visibleMarkers: [
      recentBetaLinks[0].betaLink.foreignUsername,
      recentBetaLinks.at(-1)!.betaLink.foreignUsername,
      '123,400',
      '5,678,000',
    ],
  };
}

export type HomepageFixture = ReturnType<typeof createHomepageFixture>;

function visibleText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|#39|#x27|#x2f);/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

export function assertHomepageBudget(
  response: SmokeResponse,
  expectedHeading: string,
  markers: readonly string[],
): number {
  const check = WWW_CHECKS.find((candidate) => candidate.path === '/');
  if (!check) throw new Error('Homepage production-smoke assertion is missing');
  const failure = check.assert(response);
  if (failure) throw new Error(failure);
  const heading = response.body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '';
  if (visibleText(heading) !== expectedHeading) throw new Error(`Expected homepage H1: ${expectedHeading}`);
  const main = response.body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? '';
  const rendered = visibleText(main);
  for (const marker of markers) {
    if (!rendered.includes(marker)) throw new Error(`Homepage is missing visible SSR fixture content: ${marker}`);
  }
  return gzipSync(response.body).byteLength;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || !isRunning(child)) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolveWait) => {
      timer = setTimeout(resolveWait, 2_000);
    }),
  ]);
  clearTimeout(timer);
  if (isRunning(child)) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitForServer(port: number, child: ChildProcess, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + STARTUP_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (!isRunning(child))
      throw new Error(`Next server exited before readiness (${child.exitCode ?? child.signalCode})`);
    const ready = await new Promise<boolean>((resolveReady) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolveReady(true);
      });
      socket.once('error', () => resolveReady(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolveReady(false);
      });
    });
    if (ready) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error('Next server did not become ready within 20 seconds');
}

/** No copied credentials, prior unstable_cache entries, database or vendor connections. */
export function networkFenceSource(fixturePort: number): string {
  return `const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let target = args[0];
  if (Array.isArray(target)) target = target[0];
  const options = target && typeof target === 'object' ? target : { port: target, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (options.path || options.host !== '127.0.0.1' || Number(options.port) !== ${fixturePort}) {
    console.error('${BLOCKED_CONNECTION}');
    throw new Error('${BLOCKED_CONNECTION}');
  }
  return original.apply(this, args);
};\n`;
}

export async function checkHomepageBudget(webDirectory: string) {
  const standalone = join(webDirectory, '.next/standalone');
  const relativeEntry = 'packages/web/server.js';
  let buildId: string;
  try {
    buildId = (await readFile(join(webDirectory, '.next/BUILD_ID'), 'utf8')).trim();
    const copiedBuildId = (await readFile(join(standalone, 'packages/web/.next/BUILD_ID'), 'utf8')).trim();
    if (!buildId || copiedBuildId !== buildId || !(await stat(join(standalone, relativeEntry))).isFile())
      throw new Error('incomplete artifact');
  } catch {
    throw new Error(
      'Existing Next standalone artifact is missing or incomplete. Run the existing typecheck/build task first; this checker never builds.',
    );
  }
  const catalogPath = resolve(webDirectory, '../shared/i18n/locales/en-US/marketing.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { home?: { hero?: { title?: unknown } } };
  const expectedHeading = catalog.home?.hero?.title;
  if (typeof expectedHeading !== 'string' || !expectedHeading)
    throw new Error('Expected H1 is missing from the target checkout English catalog');
  const fixture = createHomepageFixture();
  const operations = new Set<string>();
  const unexpected: string[] = [];
  const fixtureServer = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 32_768) throw new Error('Fixture request is too large');
      }
      const payload = JSON.parse(body) as { query?: unknown };
      if (request.method !== 'POST' || request.url !== '/graphql' || typeof payload.query !== 'string')
        throw new Error('Unexpected fixture request');
      const operation = /\bquery\s+(\w+)/.exec(payload.query)?.[1];
      operations.add(operation ?? '<missing>');
      let result: unknown;
      if (operation === 'GetRecentBetaLinks') result = { recentBetaLinks: fixture.recentBetaLinks };
      else if (operation === 'GetCommunityStats') result = { communityStats: fixture.communityStats };
      else if (operation === 'SearchGymsDirectory')
        result = { searchGyms: { gyms: [], totalCount: 1234, hasMore: false } };
      else throw new Error(`Unexpected fixture operation: ${operation ?? '<missing>'}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: result }));
    } catch (error) {
      unexpected.push(error instanceof Error ? error.message : 'Invalid fixture request');
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ errors: [{ message: 'Unsupported budget fixture request' }] }));
    }
  });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-homepage-budget-'));
  let child: ChildProcess | undefined;
  let logs = '';
  let blockedConnection = false;
  const timeout = new AbortController();
  const interrupt = () => {
    timeout.abort(new Error('Homepage budget check interrupted'));
    child?.kill('SIGKILL');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const timer = setTimeout(() => {
    timeout.abort(new Error('Homepage budget check exceeded 60 seconds'));
    child?.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const fixturePort = await listen(fixtureServer);
    const reservation = createServer();
    const webPort = await listen(reservation);
    await closeServer(reservation);
    const runtimeDirectory = join(temporaryDirectory, 'standalone');
    await cp(standalone, runtimeDirectory, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (source) => !basename(source).startsWith('.env') && !source.includes(`${sep}.next${sep}cache`),
    });
    timeout.signal.throwIfAborted();
    const fence = join(temporaryDirectory, 'network-fence.cjs');
    await writeFile(fence, networkFenceSource(fixturePort));
    const webOrigin = `http://127.0.0.1:${webPort}`;
    child = spawn(process.execPath, ['--require', fence, join(runtimeDirectory, relativeEntry)], {
      cwd: join(runtimeDirectory, 'packages/web'),
      env: {
        NODE_ENV: 'production',
        HOSTNAME: '127.0.0.1',
        PORT: String(webPort),
        BACKEND_INTERNAL_URL: `http://127.0.0.1:${fixturePort}/graphql`,
        NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${fixturePort}/graphql`,
        BASE_URL: webOrigin,
        NEXTAUTH_URL: webOrigin,
        NEXTAUTH_SECRET: 'homepage-budget-fixture-no-authentication',
        IRON_SESSION_PASSWORD: 'homepage-budget-fixture-no-authentication',
        DATABASE_URL: 'postgresql://homepage_budget:unused@127.0.0.1:1/homepage_budget',
        SENTRY_ENVIRONMENT: 'test',
        NEXT_TELEMETRY_DISABLED: '1',
        FEATURE_FLAG_OVERRIDES: 'cnc-packs=false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', (error) => {
      logs += error.message;
    });
    const recordLogs = (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-65_536);
      if (logs.includes(BLOCKED_CONNECTION)) blockedConnection = true;
    };
    child.stdout?.on('data', recordLogs);
    child.stderr?.on('data', recordLogs);
    await waitForServer(webPort, child, timeout.signal);
    const response = await fetch(`${webOrigin}/`, {
      redirect: 'manual',
      headers: { 'User-Agent': NORMAL_USER_AGENT, 'Accept-Language': 'en-US', Accept: 'text/html' },
      signal: AbortSignal.any([timeout.signal, AbortSignal.timeout(30_000)]),
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (!response.body) throw new Error('Homepage response has no body');
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Error('Homepage HTML exceeds the 5 MiB read limit');
      chunks.push(chunk);
    }
    const html = Buffer.concat(chunks).toString('utf8');
    const gzipBytes = assertHomepageBudget(
      {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: html,
        headers: Object.fromEntries(response.headers),
        url: response.url,
      },
      expectedHeading,
      fixture.visibleMarkers,
    );
    for (const operation of ['GetRecentBetaLinks', 'GetCommunityStats']) {
      if (!operations.has(operation))
        throw new Error(`Required live fixture operation was not requested: ${operation}`);
    }
    if (unexpected.length > 0) throw new Error(unexpected.join('; '));
    if (blockedConnection) throw new Error('Application attempted a database or non-fixture network connection');
    return {
      buildId,
      rawBytes: Buffer.byteLength(html),
      gzipBytes,
      budgetBytes: HOMEPAGE_GZIP_BUDGET_BYTES,
      betaRows: HOMEPAGE_FIXTURE_ROWS,
      expectedHeading,
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nNext server output:\n${logs || '<none>'}`,
      { cause: error },
    );
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    clearTimeout(timer);
    if (child) await stopChild(child);
    await closeServer(fixtureServer);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function parseHomepageBudgetArgs(args: readonly string[]): string {
  if (args.length === 0) return resolve('packages/web');
  if (args.length === 2 && args[0] === '--web-dir') return resolve(args[1]);
  throw new Error('Usage: check-homepage-budget.ts [--web-dir <built web directory>]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkHomepageBudget(parseHomepageBudgetArgs(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
