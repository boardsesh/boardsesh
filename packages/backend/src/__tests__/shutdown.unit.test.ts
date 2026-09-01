import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { FORCE_SHUTDOWN_TIMEOUT_MS } from '../shutdown-timing';

// These are unit tests that verify the shutdown plumbing is wired correctly
// without requiring a database connection.

const ROOT = resolve(__dirname, '../..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

/**
 * Source with comments stripped. Ordering assertions below search for calls like
 * `wss.close(`, and the comments in index.ts discuss those same calls by name —
 * scanning the raw text would match the prose explaining the code rather than
 * the code itself.
 *
 * The `[^:]` guard keeps `https://` and other scheme-prefixed URLs intact. A
 * bare `'//…'` string literal would still be truncated, so `expectAnchors`
 * below re-checks that every call site the assertions rely on survived — a
 * stripping bug should fail loudly rather than silently reorder the positions.
 */
function readCode(relativePath: string): string {
  return readSource(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('shutdown: closePool wiring', () => {
  it('index.ts imports closePool and closeReadPool from @boardsesh/db/client', () => {
    const source = readSource('src/index.ts');
    expect(source).toContain("import { closePool, closeReadPool } from '@boardsesh/db/client'");
    expect(source).toContain('await closePool()');
    expect(source).toContain('await closeReadPool()');
  });

  it('index.ts logs when pools are closed', () => {
    const source = readSource('src/index.ts');
    expect(source).toContain("'Database pools closed'");
  });

  it('index.ts handles pool close errors gracefully', () => {
    const source = readSource('src/index.ts');
    // closePool should be in a try/catch
    expect(source).toContain("'Error closing database pools:'");
  });

  it('index.ts closes read pool before primary pool', () => {
    const source = readSource('src/index.ts');
    const readIdx = source.indexOf('await closeReadPool()');
    const primaryIdx = source.indexOf('await closePool()');
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeLessThan(primaryIdx);
  });
});

describe('shutdown: server resources interface', () => {
  const serverSource = readSource('src/server.ts');

  it('exports ServerResources with cleanupIntervals and shutdownServices', () => {
    expect(serverSource).toContain('cleanupIntervals: () => void');
    expect(serverSource).toContain('shutdownServices: () => Promise<void>');
  });

  it('returns cleanupIntervals and shutdownServices from startServer', () => {
    expect(serverSource).toContain('return { wss, httpServer, cleanupIntervals, shutdownServices }');
  });

  it('does not register its own SIGTERM/SIGINT handlers', () => {
    // server.ts should not have process.on('SIGTERM'/'SIGINT') — that's index.ts's job
    const sigTermMatches = serverSource.match(/process\.on\(['"]SIGTERM['"]/g);
    const sigIntMatches = serverSource.match(/process\.on\(['"]SIGINT['"]/g);
    expect(sigTermMatches).toBeNull();
    expect(sigIntMatches).toBeNull();
  });
});

describe('shutdown: re-entrancy guard', () => {
  it('index.ts prevents double shutdown', () => {
    const source = readSource('src/index.ts');
    expect(source).toContain('shuttingDown');
  });
});

describe('shutdown: ordering', () => {
  it('index.ts shuts down services before closing the pool', () => {
    const source = readSource('src/index.ts');
    const servicesIdx = source.indexOf('shutdownServices');
    const poolIdx = source.indexOf('closePool()');
    expect(servicesIdx).toBeLessThan(poolIdx);
  });

  it('index.ts closes HTTP/WS before closing the pool', () => {
    const source = readSource('src/index.ts');
    const httpIdx = source.indexOf('httpServer.close');
    const poolIdx = source.indexOf('closePool()');
    expect(httpIdx).toBeLessThan(poolIdx);
  });
});

describe('pool configuration', () => {
  // Was a grep of postgres.ts for the literal `idle_timeout: 30`. #4461 made
  // both knobs env-derived (`DB_POOL_MAX` / `DB_POOL_IDLE_TIMEOUT_S`, defaults
  // unchanged), which would have left that grep green-but-meaningless. Assert
  // on the options postgres-js actually resolved instead — the backend must
  // keep the pre-#4461 sizing unless someone sets the env vars on it, which
  // only the Vercel project is expected to do.
  //
  // These overlap `packages/db/src/client/__tests__/postgres.test.ts` on
  // purpose. `packages/db` is not a Vitest project and the only db test CI runs
  // is the migration-journal one, so knob assertions living only there would be
  // inert in CI. The backend project runs on every PR.
  async function poolOptionsWith(env: Record<string, string | undefined>) {
    const { createPool, closePool } = await import('@boardsesh/db/client');
    const previous: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(env)) {
      previous[name] = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    await closePool();
    try {
      return createPool().options;
    } finally {
      await closePool();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it('keeps the pre-#4461 pool defaults when the env knobs are unset', async () => {
    const { max, idle_timeout: idleTimeout } = await poolOptionsWith({
      DB_POOL_MAX: undefined,
      DB_POOL_IDLE_TIMEOUT_S: undefined,
    });

    expect(max).toBe(10);
    expect(idleTimeout).toBe(30);
  });

  it('honours the per-deployment knobs when they are set', async () => {
    const { max, idle_timeout: idleTimeout } = await poolOptionsWith({
      DB_POOL_MAX: '4',
      DB_POOL_IDLE_TIMEOUT_S: '10',
    });

    expect(max).toBe(4);
    expect(idleTimeout).toBe(10);
  });

  it('clamps DB_POOL_MAX to the two-connection floor and falls back on garbage', async () => {
    // getClimb issues two sequential statements; a pool of one serialises every
    // front-door render behind a single connection.
    expect((await poolOptionsWith({ DB_POOL_MAX: '1' })).max).toBe(2);
    expect((await poolOptionsWith({ DB_POOL_MAX: 'abc' })).max).toBe(10);
  });

  it('lets DB_POOL_IDLE_TIMEOUT_S=0 mean "never close an idle connection"', async () => {
    // postgres.js reads a falsy idle_timeout as disabled. Clamping it up to 1
    // would turn "hold connections open" into a teardown every second.
    expect((await poolOptionsWith({ DB_POOL_IDLE_TIMEOUT_S: '0' })).idle_timeout).toBe(0);
  });

  it('ships with no statement_timeout startup parameter', async () => {
    // PgBouncer in transaction-pooling mode rejects unknown startup parameters,
    // so enabling this against a pooled URL fails every connection rather than
    // bounding one query. See docs/db-connectivity.md.
    const options = await poolOptionsWith({ DB_STATEMENT_TIMEOUT_MS: undefined });
    expect(options.connection.statement_timeout).toBeUndefined();
  });

  it('emits statement_timeout only when DB_STATEMENT_TIMEOUT_MS is set', async () => {
    const options = await poolOptionsWith({ DB_STATEMENT_TIMEOUT_MS: '8000' });
    expect(options.connection.statement_timeout).toBe(8000);
  });
});

describe('closePool implementation', () => {
  const source = readFileSync(resolve(ROOT, '../db/src/client/postgres.ts'), 'utf-8');

  it('is exported from postgres.ts', () => {
    expect(source).toContain('export async function closePool()');
  });

  it('ends the client and clears the cached pool', () => {
    expect(source).toContain('await cache.client.end()');
    expect(source).toContain('cache.client = undefined');
  });

  it('clears the cached drizzle singleton', () => {
    expect(source).toContain('cache.db = undefined');
  });

  it('uses try/finally to ensure singletons are nulled even if .end() throws', () => {
    const tryCount = (source.match(/try\s*\{/g) ?? []).length;
    const finallyCount = (source.match(/finally\s*\{/g) ?? []).length;
    expect(finallyCount).toBeGreaterThanOrEqual(1);
    expect(tryCount).toBeGreaterThanOrEqual(finallyCount);
  });

  it('is re-exported from client/index.ts', () => {
    const indexSource = readFileSync(resolve(ROOT, '../db/src/client/index.ts'), 'utf-8');
    expect(indexSource).toContain('closePool');
  });

  it('closeReadPool is exported and re-exported', () => {
    expect(source).toContain('export async function closeReadPool()');
    const indexSource = readFileSync(resolve(ROOT, '../db/src/client/index.ts'), 'utf-8');
    expect(indexSource).toContain('closeReadPool');
  });

  it('postgres-js clients are configured with prepare:false for PgBouncer', () => {
    expect(source).toContain('prepare: false');
  });
});

describe('shutdown: stop accepting before the slow teardown', () => {
  const source = readCode('src/index.ts');

  it('starts the HTTP close before closing the WebSocket server', () => {
    // wss.close() does not resolve until every client is gone, and a peer that
    // never answers the close frame holds it for ws's 30s closeTimeout — longer
    // than FORCE_SHUTDOWN_TIMEOUT_MS. If the listener were closed after that,
    // one stuck socket would keep the process taking new HTTP requests right up
    // to a force exit that severs them.
    const httpCloseIdx = source.indexOf('httpServer.close(');
    const wssCloseIdx = source.indexOf('wss.close(');
    expect(httpCloseIdx).toBeGreaterThanOrEqual(0);
    expect(wssCloseIdx).toBeGreaterThanOrEqual(0);
    expect(httpCloseIdx).toBeLessThan(wssCloseIdx);
  });

  it('still awaits the HTTP close before touching the pools', () => {
    const awaitIdx = source.indexOf('await httpServerClosed');
    expect(awaitIdx).toBeGreaterThanOrEqual(0);
    expect(awaitIdx).toBeLessThan(source.indexOf('await closeReadPool()'));
  });

  it('keeps every anchor the ordering assertions depend on', () => {
    // Guards readCode itself: if comment stripping ever ate real code, the
    // indexOf comparisons above would silently compare -1s instead of failing.
    for (const anchor of ['httpServer.close(', 'wss.close(', 'await httpServerClosed', 'await closeReadPool()']) {
      expect(source).toContain(anchor);
    }
  });

  it('does not call closeIdleConnections, which close() already does', () => {
    // Not a style rule. http.Server.close() is documented to close "all
    // connections ... which are not sending a request or waiting for a
    // response", and its v19.0.0 change note reads "The method closes idle
    // connections before returning"
    // (https://nodejs.org/api/http.html#serverclosecallback). package.json pins
    // Node 22, so the call would be dead code. If a future Node reverses this,
    // delete this test alongside re-adding the call.
    expect(source).not.toContain('closeIdleConnections');
  });
});

describe('shutdown: Railway draining window', () => {
  // Railway's default draining time is 0s — SIGTERM and SIGKILL arrive
  // together, so none of the graceful shutdown above ever runs in production
  // and in-flight requests are severed (observed as a 504 on
  // POST /auth/native/credentials during a deploy). These pin the config that
  // makes the graceful path reachable.
  const railwayToml = readFileSync(resolve(ROOT, '../../railway.toml'), 'utf-8');
  const webRailwayToml = readFileSync(resolve(ROOT, '../../railway.web.toml'), 'utf-8');

  // Deliberately rejects a quoted value: railway.schema.json types
  // drainingSeconds as {"type": "number"}, and a TOML string risks being
  // rejected — which would silently restore Railway's 0s default and undo all
  // of the above. The prose docs show it quoted; the schema wins.
  function drainingSeconds(toml: string): number {
    const match = /^\s*drainingSeconds\s*=\s*(\d+)\s*$/m.exec(toml);
    expect(match).not.toBeNull();
    return Number(match?.[1]);
  }

  it('gives the backend a draining window', () => {
    expect(drainingSeconds(railwayToml)).toBeGreaterThan(0);
  });

  it('gives the web service a draining window', () => {
    expect(drainingSeconds(webRailwayToml)).toBeGreaterThan(0);
  });

  it('drains for longer than the force-exit timer, so the graceful path owns the shutdown', () => {
    // Railway SIGKILLs once the draining window closes, so a force timer above
    // it would never fire — the process would die mid-flush instead.
    expect(drainingSeconds(railwayToml) * 1000).toBeGreaterThan(FORCE_SHUTDOWN_TIMEOUT_MS);
  });

  it('uses the shared force-exit constant rather than a bare literal', () => {
    // Whitespace-tolerant: the point is that the setTimeout delay is the shared
    // constant, not that the file is formatted a particular way.
    expect(readSource('src/index.ts')).toMatch(/setTimeout\([\s\S]*?\}\s*,\s*FORCE_SHUTDOWN_TIMEOUT_MS\s*\)/);
  });
});
