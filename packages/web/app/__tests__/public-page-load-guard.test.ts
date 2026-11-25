// @vitest-environment node
import { createRequire } from 'node:module';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

type Handler = (request: IncomingMessage, response: ServerResponse) => unknown;
type GuardStats = {
  active: number;
  admitted: number;
  completed: number;
  capacity: number;
  deadline: number;
  pressure: boolean;
};
type Guard = { wrap: (handler: Handler) => Handler; getStats: () => GuardStats; report: () => void; close: () => void };
type GuardOptions = {
  maxConcurrency?: number;
  timeoutMs?: number;
  readHeap?: () => { used: number; limit: number };
  reportIntervalMs?: number;
  log?: (metrics: Record<string, unknown>) => void;
  now?: () => number;
};
const { createPublicPageLoadGuard, isPublicCatalogueRequest } = createRequire(import.meta.url)(
  '../../scripts/public-page-load-guard.cjs',
) as {
  createPublicPageLoadGuard: (options?: GuardOptions) => Guard;
  isPublicCatalogueRequest: (method: string, requestUrl: string) => boolean;
};
const CLIMB_PATH = '/moonboard/mini-2020/full/all/40/view/climb-uuid';
const servers: Server[] = [];
const guards: Guard[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function guardWith(options: GuardOptions = {}): Guard {
  const guard = createPublicPageLoadGuard({
    reportIntervalMs: 0,
    readHeap: () => ({ used: 10, limit: 100 }),
    ...options,
  });
  guards.push(guard);
  return guard;
}

async function listen(handler: Handler): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an HTTP port');
  return address.port;
}

async function get(port: number, path = CLIMB_PATH, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('HTTP lifecycle did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  for (const guard of guards.splice(0)) guard.close();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe('public catalogue request classification', () => {
  it.each([
    CLIMB_PATH,
    '/b/my-wall/40/view/climb',
    '/zh-CN/b/my-wall/40/view/climb/',
    '/fr/moonboard/mini-2020/full/all/40/view/climb',
    '/setter/setter-name',
    '/profile/user-id',
    '/gym/somewhere',
    '/gyms',
    '/playlists',
    '/playlists/uuid',
    '/b/my-wall',
    '/b/my-wall/40/list',
    '/moonboard/mini/full/all/40/list',
    '/IT/SETTER/Somebody/',
    '//es//setter//somebody/',
    '/es/%73etter/somebody',
    '/setter/some%2Fbody',
    '/setter/some%252Fbody',
    '/moonboard/mini/full/all/40/view/name%2Fwith-slash-uuid',
    '/moonboard/mini/full/all/40/%76iew/climb',
    '/setter/bad%encoding',
  ])('covers document and RSC requests to %s', (path) => {
    expect(isPublicCatalogueRequest('GET', path)).toBe(true);
    expect(isPublicCatalogueRequest('HEAD', path)).toBe(true);
  });

  it.each([
    '/api/health',
    '/api/a/b/c/d/view/climb',
    '/auth/login',
    '/admin/catalog',
    '/settings/profile',
    '/app',
    '/_next/static/thing.js',
    '/images/climb.png',
    '/robots.txt',
    '/sitemap.xml',
  ])('exempts %s', (path) => {
    expect(isPublicCatalogueRequest('GET', path)).toBe(false);
  });

  it('does not intercept writes', () => expect(isPublicCatalogueRequest('POST', CLIMB_PATH)).toBe(false));
});

describe('public catalogue HTTP budget', () => {
  it('returns a non-cacheable 503 with no queue while health and API traffic continue', async () => {
    const guard = guardWith({ maxConcurrency: 1 });
    const pending = deferred();
    const started = deferred();
    let renders = 0;
    const port = await listen(
      guard.wrap(async (incoming, response) => {
        if (incoming.url?.startsWith('/api/')) {
          response.end('healthy');
          return;
        }
        renders += 1;
        started.resolve();
        await pending.promise;
        response.end('climb');
      }),
    );
    const first = get(port);
    await started.promise;
    const second = await get(port, '/es/b/wall/40/view/climb?_rsc=abc', {
      rsc: '1',
      'user-agent': 'Googlebot',
      cookie: 'signed-in=true',
    });
    expect(second.status).toBe(503);
    expect(second.headers).toMatchObject({
      'retry-after': '5',
      'cache-control': 'no-store',
      'cdn-cache-control': 'no-store',
      'vercel-cdn-cache-control': 'no-store',
    });
    expect(renders).toBe(1);
    expect((await get(port, '/api/health')).body).toBe('healthy');
    expect(guard.getStats()).toMatchObject({ active: 1, capacity: 1 });
    pending.resolve();
    expect((await first).body).toBe('climb');
    await eventually(() => guard.getStats().active === 0);
  });

  it('holds the slot after response completion until background handler work settles', async () => {
    const guard = guardWith({ maxConcurrency: 1 });
    const pending = deferred();
    const port = await listen(
      guard.wrap(async (_incoming, response) => {
        response.end('climb');
        await pending.promise;
      }),
    );
    expect((await get(port)).status).toBe(200);
    expect(guard.getStats().active).toBe(1);
    expect((await get(port)).status).toBe(503);
    pending.resolve();
    await eventually(() => guard.getStats().active === 0);
  });

  it('holds the slot after a handler returns until the entire stream finishes', async () => {
    const guard = guardWith({ maxConcurrency: 1 });
    const started = deferred();
    let finishStream!: () => void;
    const port = await listen(
      guard.wrap((_incoming, response) => {
        response.write('start');
        finishStream = () => response.end('end');
        started.resolve();
      }),
    );
    const first = get(port);
    await started.promise;
    expect((await get(port)).status).toBe(503);
    finishStream();
    expect((await first).body).toBe('startend');
    await eventually(() => guard.getStats().active === 0);
  });

  it('ends a pre-header timeout with 503 and retains its slot while abandoned work continues', async () => {
    const guard = guardWith({ maxConcurrency: 1, timeoutMs: 40 });
    const pending = deferred();
    const closed = deferred();
    let capturedResponse!: ServerResponse;
    const port = await listen(
      guard.wrap(async (_incoming, response) => {
        capturedResponse = response;
        response.once('close', closed.resolve);
        await pending.promise;
      }),
    );
    expect((await get(port)).status).toBe(503);
    await closed.promise;
    expect(guard.getStats()).toMatchObject({ active: 1, deadline: 1 });
    expect((await get(port)).status).toBe(503);
    expect(capturedResponse.listeners('close').filter((listener) => listener.name === 'ended')).toHaveLength(0);
    expect(capturedResponse.listeners('finish').filter((listener) => listener.name === 'ended')).toHaveLength(0);
    pending.resolve();
    await eventually(() => guard.getStats().active === 0);
  });

  it('destroys a timed-out stream so Next receives its response-close cancellation', async () => {
    const guard = guardWith({ timeoutMs: 40 });
    const port = await listen(
      guard.wrap(async (_incoming, response) => {
        const closed = new Promise<void>((resolve) => response.once('close', resolve));
        response.write('partial');
        await closed;
      }),
    );
    await expect(get(port)).rejects.toMatchObject({ code: 'ECONNRESET' });
    await eventually(() => guard.getStats().active === 0);
    expect(guard.getStats().deadline).toBe(1);
  });

  it('retains disconnected work until the handler settles and releases exactly once', async () => {
    const guard = guardWith({ maxConcurrency: 1 });
    const pending = deferred();
    const responseClosed = deferred();
    const port = await listen(
      guard.wrap(async (_incoming, response) => {
        response.once('close', responseClosed.resolve);
        response.write('partial');
        await pending.promise;
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const outgoing = request({ hostname: '127.0.0.1', port, path: CLIMB_PATH }, (response) => {
        response.once('data', () => {
          response.destroy();
          resolve();
        });
        response.on('error', () => {});
      });
      outgoing.once('error', reject);
      outgoing.end();
    });
    await responseClosed.promise;
    expect(guard.getStats().active).toBe(1);
    expect((await get(port)).status).toBe(503);
    pending.resolve();
    await eventually(() => guard.getStats().active === 0);
    expect(guard.getStats().completed).toBe(1);
  });

  it('preserves handler rejection for its owner and releases after the error response', async () => {
    const guard = guardWith();
    const failure = new Error('render failed');
    const handler = guard.wrap(async () => {
      throw failure;
    });
    const observed = vi.fn();
    const port = await listen((incoming, response) => {
      void Promise.resolve(handler(incoming, response)).catch((error: unknown) => {
        observed(error);
        response.writeHead(500).end();
      });
    });
    expect((await get(port)).status).toBe(500);
    await eventually(() => guard.getStats().active === 0);
    expect(observed).toHaveBeenCalledWith(failure);
  });

  it('uses V8 heap-limit hysteresis and reports continuing pressure without request identities', async () => {
    let used = 71;
    let now = 1_000;
    const log = vi.fn();
    const guard = guardWith({ readHeap: () => ({ used, limit: 100 }), now: () => now, log });
    const port = await listen(guard.wrap((_incoming, response) => response.end('climb')));
    expect((await get(port)).status).toBe(503);
    used = 65;
    expect((await get(port)).status).toBe(503);
    now += 30_000;
    guard.report();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ pressure: true, pressureRejected: 2, pressureMs: 30_000, heapLimitBytes: 100 }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(CLIMB_PATH);
    used = 60;
    expect((await get(port)).status).toBe(200);
    used = 69;
    expect((await get(port)).status).toBe(200);
  });

  it('preloads before standalone-style creation and preserves options and named ESM imports', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/public-page-load-guard-preload.mjs', import.meta.url))],
      { timeout: 5_000 },
    );
    expect(JSON.parse(stdout)).toEqual({
      installedOnce: true,
      namedImportUpdated: true,
      status: 503,
      headersTimeout: 12_345,
    });
  });

  it('lets the installed Next server finish an in-flight response during SIGTERM draining', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/public-page-load-guard-drain.cjs', import.meta.url))],
      { timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '' } },
    );
    expect(JSON.parse(stdout)).toEqual({ body: 'startend', code: 143, signal: null, nextClosed: true });
  });

  it('cancels the installed Next production Flight renderer on deadlines before and after headers', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/public-page-load-guard-flight.cjs', import.meta.url))],
      { timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '' } },
    );
    const clean = {
      completed: 0,
      errors: ['ResponseAborted'],
      reported: [],
      aborts: ['ResponseAborted'],
      active: 0,
      deadline: 1,
    };
    expect(JSON.parse(stdout)).toEqual({
      beforeHeaders: { ...clean, status: 503, aborted: false },
      streaming: { ...clean, status: 200, aborted: true },
    });
  });

  it('recovers from real disposable heap pressure without forcing GC or restarting', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--max-old-space-size=256',
        fileURLToPath(new URL('./fixtures/public-page-load-guard-pressure.cjs', import.meta.url)),
      ],
      { timeout: 45_000, env: { ...process.env, NODE_OPTIONS: '' } },
    );
    const report = JSON.parse(stdout) as {
      initialStatus: number;
      recoveredAfterMs: number | null;
      heapFraction: number;
      stats: GuardStats;
    };
    expect(report.initialStatus).toBe(503);
    expect(report.recoveredAfterMs).not.toBeNull();
    expect(report.heapFraction).toBeLessThan(0.6);
    expect(report.stats).toMatchObject({ active: 0, pressure: false });
  }, 50_000);
});
