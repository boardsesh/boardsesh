import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// These are unit tests that verify the shutdown plumbing is wired correctly
// without requiring a database connection.

const ROOT = resolve(__dirname, '../..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
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
  it('keeps the pre-#4461 pool defaults when the env knobs are unset', async () => {
    const { createPool, closePool } = await import('@boardsesh/db/client');
    const previousMax = process.env.DB_POOL_MAX;
    const previousIdle = process.env.DB_POOL_IDLE_TIMEOUT_S;
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_IDLE_TIMEOUT_S;

    await closePool();
    try {
      const { max, idle_timeout: idleTimeout } = createPool().options;
      expect(max).toBe(10);
      expect(idleTimeout).toBe(30);
    } finally {
      await closePool();
      if (previousMax !== undefined) process.env.DB_POOL_MAX = previousMax;
      if (previousIdle !== undefined) process.env.DB_POOL_IDLE_TIMEOUT_S = previousIdle;
    }
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
