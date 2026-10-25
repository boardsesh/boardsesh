/// <reference types="node" />

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCarryoverManifest,
  carryOverChunks,
  collectChunkRefs,
  collectEagerScripts,
  isJavaScriptResponse,
  parseCarryoverManifest,
  selectCarryCandidates,
} from '../lib/carry-over-expo-web-chunks.mjs';

// #5780: every app.boardsesh.com deploy used to drop the previous deploy's
// chunks, so a tab opened before the deploy 404ed on its next lazy route.

const LIVE = 'https://app.example.test';
const NOW_MS = Date.parse('2026-10-25T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const chunk = (name: string) => `/_expo/static/js/web/${name}.js`;

/** The pathname a fetch call asked for, whatever form its input took. */
function requestedPath(input: string | URL | Request): string {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(href).pathname;
}

type LiveFile = { status?: number; contentType?: string; body: string };

/** An in-memory app.boardsesh.com. Unknown paths answer like the asset Function: 404. */
function liveSite(files: Record<string, LiveFile>, requested: string[] = []): typeof fetch {
  return async (input) => {
    const pathname = requestedPath(input);
    requested.push(pathname);
    const file = files[pathname];
    if (!file) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(file.body, {
      status: file.status ?? 200,
      headers: { 'content-type': file.contentType ?? 'application/javascript' },
    });
  };
}

/** Adds a delay to every request and records the most requests ever in flight at once. */
function withLatency(fetchImpl: typeof fetch, delayMs: number) {
  const stats = { inFlight: 0, peakInFlight: 0 };
  const slowFetch: typeof fetch = async (input, init) => {
    stats.inFlight += 1;
    stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await fetchImpl(input, init);
    } finally {
      stats.inFlight -= 1;
    }
  };
  return { fetchImpl: slowFetch, stats };
}

/** Delays only the named paths, so a test can pick which download finishes last. */
function withSlowPaths(fetchImpl: typeof fetch, slowPaths: Record<string, number>): typeof fetch {
  return async (input, init) => {
    const delayMs = slowPaths[requestedPath(input)];
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fetchImpl(input, init);
  };
}

const shell = (...scripts: string[]) =>
  `<!doctype html><html><body><div id="root"></div>${scripts
    .map((script) => `<script src="${script}" defer></script>`)
    .join('')}</body></html>`;
const html = (body: string): LiveFile => ({ contentType: 'text/html; charset=utf-8', body });
const js = (body: string): LiveFile => ({ body });

let exportDir: string;
let warnings: string[];

beforeEach(() => {
  exportDir = mkdtempSync(join(tmpdir(), 'carry-over-'));
  mkdirSync(join(exportDir, '_expo', 'static', 'js', 'web'), { recursive: true });
  warnings = [];
});

afterEach(() => {
  rmSync(exportDir, { recursive: true, force: true });
});

function writeExportChunk(chunkPath: string, body: string) {
  writeFileSync(join(exportDir, chunkPath), body);
}

function readExportChunk(chunkPath: string) {
  return readFileSync(join(exportDir, chunkPath), 'utf8');
}

function readWrittenManifest() {
  return JSON.parse(readFileSync(join(exportDir, 'chunk-carryover.json'), 'utf8')) as {
    version: number;
    current: string[];
    carried: Record<string, string>;
  };
}

function run(fetchImpl: typeof fetch, overrides: { maxFiles?: number; maxAgeDays?: number } = {}) {
  return carryOverChunks({
    exportDir,
    liveOrigin: LIVE,
    maxAgeDays: overrides.maxAgeDays ?? 3,
    maxFiles: overrides.maxFiles ?? 4000,
    nowMs: NOW_MS,
    fetchImpl,
    warn: (message: string) => warnings.push(message),
  });
}

describe('pure helpers', () => {
  it('collects chunk references the way inspect-expo-web-export.mjs does', () => {
    const source = `a("${chunk('route-a')}");b('${chunk('route-b')}');c(\`${chunk('route-a')}\`);d("/assets/x.png")`;
    expect(collectChunkRefs(source)).toEqual([chunk('route-a'), chunk('route-b')]);
  });

  it('collects eager scripts and ignores anything outside the chunk directory', () => {
    const shellHtml = shell(chunk('entry-1'), `${LIVE}${chunk('__common-1')}`, '/other/thing.js');
    expect(collectEagerScripts(shellHtml)).toEqual([chunk('entry-1'), chunk('__common-1')]);
  });

  it('reads an unparseable or foreign manifest as empty', () => {
    expect(parseCarryoverManifest('<!doctype html>').carried.size).toBe(0);
    expect(parseCarryoverManifest('{"version":2,"current":["x"]}').current).toEqual([]);
    const manifest = parseCarryoverManifest(
      JSON.stringify({
        version: 1,
        current: [chunk('a'), '/_expo/static/js/web/../../../../etc/passwd.js'],
        carried: { [chunk('b')]: '2026-10-24T00:00:00.000Z', [chunk('c')]: 'not a date', '/elsewhere.js': 'x' },
      }),
    );
    expect(manifest.current).toEqual([chunk('a')]);
    expect([...manifest.carried.keys()]).toEqual([chunk('b')]);
  });

  it('keeps live files at now, carried files under the age cap, newest first', () => {
    const manifest = parseCarryoverManifest(
      JSON.stringify({
        version: 1,
        current: [chunk('route-n1')],
        carried: {
          [chunk('two-days')]: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
          [chunk('four-days')]: new Date(NOW_MS - 4 * DAY_MS).toISOString(),
          [chunk('one-day')]: new Date(NOW_MS - DAY_MS).toISOString(),
        },
      }),
    );
    const candidates = selectCarryCandidates({
      livePaths: [chunk('entry-n1')],
      manifest,
      nowMs: NOW_MS,
      maxAgeMs: 3 * DAY_MS,
    });
    expect(candidates.map((candidate: { path: string }) => candidate.path)).toEqual([
      chunk('entry-n1'),
      chunk('route-n1'),
      chunk('one-day'),
      chunk('two-days'),
    ]);
  });

  it('accepts only a 200 JavaScript body', () => {
    expect(isJavaScriptResponse({ status: 200, contentType: 'application/javascript', bodyStart: 'var a' })).toBe(true);
    expect(isJavaScriptResponse({ status: 404, contentType: 'application/javascript', bodyStart: 'var a' })).toBe(
      false,
    );
    expect(isJavaScriptResponse({ status: 200, contentType: 'text/html', bodyStart: 'var a' })).toBe(false);
    expect(isJavaScriptResponse({ status: 200, contentType: 'application/javascript', bodyStart: '  <!doctype' })).toBe(
      false,
    );
  });

  it('writes the current build as current and every carried file with its timestamp', () => {
    const manifest = buildCarryoverManifest({
      currentPaths: [chunk('entry-n')],
      carried: new Map([[chunk('entry-n1'), NOW_MS]]),
      nowMs: NOW_MS,
    });
    expect(manifest).toEqual({
      version: 1,
      generatedAt: '2026-10-25T12:00:00.000Z',
      current: [chunk('entry-n')],
      carried: { [chunk('entry-n1')]: '2026-10-25T12:00:00.000Z' },
    });
  });
});

describe('carryOverChunks', () => {
  it("carries the live deploy's eager scripts and the chunks they name", async () => {
    writeExportChunk(chunk('entry-n'), 'fresh entry');
    const fetchImpl = liveSite({
      '/': html(shell(chunk('__expo-metro-runtime-n1'), chunk('entry-n1'), chunk('__common-n1'))),
      [chunk('__expo-metro-runtime-n1')]: js('runtime'),
      [chunk('entry-n1')]: js(`load("${chunk('route-climbs-n1')}")`),
      [chunk('__common-n1')]: js(`load("${chunk('route-you-n1')}")`),
      [chunk('route-climbs-n1')]: js(`load("${chunk('nested-n1')}")`),
      [chunk('route-you-n1')]: js('you'),
      [chunk('nested-n1')]: js('nested'),
    });

    const result = await run(fetchImpl);

    for (const name of ['__expo-metro-runtime-n1', 'entry-n1', '__common-n1', 'route-climbs-n1', 'route-you-n1']) {
      expect(existsSync(join(exportDir, chunk(name))), name).toBe(true);
    }
    expect(existsSync(join(exportDir, chunk('nested-n1')))).toBe(true);
    expect(result.carriedCount).toBe(6);
    // The entry, not Metro's runtime that the shell loads first.
    expect(result.previousEntry).toBe(chunk('entry-n1'));
    expect(warnings).toEqual([]);

    const manifest = readWrittenManifest();
    expect(manifest.current).toEqual([chunk('entry-n')]);
    expect(Object.keys(manifest.carried)).toHaveLength(6);
    expect(new Set(Object.values(manifest.carried))).toEqual(new Set([new Date(NOW_MS).toISOString()]));
  });

  it('downloads the routes a bootstrap entry names in parallel, not one at a time', async () => {
    // The first run's queue holds only the 2 eager scripts. The 40 routes the
    // entry names arrive while the other workers would otherwise have quit.
    const routeNames = Array.from({ length: 40 }, (_unused, index) => `route-${index}`);
    const files: Record<string, LiveFile> = {
      '/': html(shell(chunk('__expo-metro-runtime-n1'), chunk('entry-n1'))),
      [chunk('__expo-metro-runtime-n1')]: js('runtime'),
      [chunk('entry-n1')]: js(routeNames.map((name) => `load("${chunk(name)}")`).join(';')),
    };
    for (const name of routeNames) files[chunk(name)] = js(name);
    const { fetchImpl, stats } = withLatency(liveSite(files), 20);

    const result = await run(fetchImpl);

    expect(result.carriedCount).toBe(42);
    expect(stats.peakInFlight).toBe(8);
    expect(warnings).toEqual([]);
  });

  it('retries a manifest answered 503 once and carries what it lists', async () => {
    let manifestRequests = 0;
    const site = liveSite({
      '/': html(shell(chunk('entry-n1'))),
      [chunk('entry-n1')]: js('entry'),
      [chunk('route-one-day')]: js('one'),
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      if (requestedPath(input) !== '/chunk-carryover.json') return site(input, init);
      manifestRequests += 1;
      if (manifestRequests === 1) return new Response('busy', { status: 503 });
      return new Response(
        JSON.stringify({
          version: 1,
          current: [chunk('entry-n1')],
          carried: { [chunk('route-one-day')]: new Date(NOW_MS - DAY_MS).toISOString() },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };

    await run(fetchImpl);

    expect(manifestRequests).toBe(2);
    expect(existsSync(join(exportDir, chunk('route-one-day')))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('warns when the manifest keeps failing with something other than a 404', async () => {
    const site = liveSite({ '/': html(shell(chunk('entry-n1'))), [chunk('entry-n1')]: js('entry') });
    const fetchImpl: typeof fetch = async (input, init) =>
      requestedPath(input) === '/chunk-carryover.json' ? new Response('slow down', { status: 429 }) : site(input, init);

    const result = await run(fetchImpl);

    expect(result.carriedCount).toBe(1);
    expect(warnings).toEqual([expect.stringContaining('/chunk-carryover.json answered 429 twice')]);
  });

  it('carries a manifest entry 2 days old and drops one 4 days old', async () => {
    const fetchImpl = liveSite({
      '/': html(shell(chunk('entry-n1'))),
      [chunk('entry-n1')]: js('entry'),
      '/chunk-carryover.json': {
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          current: [chunk('entry-n1')],
          carried: {
            [chunk('route-two-days')]: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
            [chunk('route-four-days')]: new Date(NOW_MS - 4 * DAY_MS).toISOString(),
          },
        }),
      },
      [chunk('route-two-days')]: js('two'),
      [chunk('route-four-days')]: js('four'),
    });

    await run(fetchImpl);

    expect(existsSync(join(exportDir, chunk('route-two-days')))).toBe(true);
    expect(existsSync(join(exportDir, chunk('route-four-days')))).toBe(false);
    expect(readWrittenManifest().carried[chunk('route-two-days')]).toBe(new Date(NOW_MS - 2 * DAY_MS).toISOString());
  });

  it('never re-downloads or overwrites a file the fresh build already has', async () => {
    writeExportChunk(chunk('__common-same'), 'fresh bytes');
    const requested: string[] = [];
    const fetchImpl = liveSite(
      {
        '/': html(shell(chunk('entry-n1'), chunk('__common-same'))),
        [chunk('entry-n1')]: js('entry'),
        [chunk('__common-same')]: js('live bytes'),
      },
      requested,
    );

    const result = await run(fetchImpl);

    expect(readExportChunk(chunk('__common-same'))).toBe('fresh bytes');
    expect(requested).not.toContain(chunk('__common-same'));
    expect(readWrittenManifest().current).toContain(chunk('__common-same'));
    expect(readWrittenManifest().carried).not.toHaveProperty(chunk('__common-same'));
    expect(result.carriedCount).toBe(1);
  });

  it('drops a chunk answered with HTML or a 404, warns, and keeps going', async () => {
    const fetchImpl = liveSite({
      '/': html(shell(chunk('entry-n1'))),
      [chunk('entry-n1')]: js(`a("${chunk('shell-instead')}");b("${chunk('gone')}");c("${chunk('fine')}")`),
      [chunk('shell-instead')]: html('<!doctype html><html></html>'),
      [chunk('fine')]: js('fine'),
    });

    const result = await run(fetchImpl);

    expect(existsSync(join(exportDir, chunk('shell-instead')))).toBe(false);
    expect(existsSync(join(exportDir, chunk('gone')))).toBe(false);
    expect(existsSync(join(exportDir, chunk('fine')))).toBe(true);
    expect(result.carriedCount).toBe(2);
    expect(warnings.some((message) => message.includes(chunk('shell-instead')))).toBe(true);
    expect(warnings.some((message) => message.includes(chunk('gone')))).toBe(true);
  });

  it('fails open when the live site is down: no throw, manifest of the fresh build only', async () => {
    writeExportChunk(chunk('entry-n'), 'fresh entry');
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };

    const result = await run(fetchImpl);

    expect(result.carriedCount).toBe(0);
    expect(result.previousEntry).toBe('');
    expect(result.manifestWritten).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(readWrittenManifest()).toMatchObject({ version: 1, current: [chunk('entry-n')], carried: {} });
  });

  it('fails open when the live site answers with garbage', async () => {
    const fetchImpl = liveSite({
      '/': { status: 503, contentType: 'text/plain', body: 'upstream error' },
      '/chunk-carryover.json': html('<!doctype html>'),
    });

    const result = await run(fetchImpl);

    expect(result.carriedCount).toBe(0);
    expect(readWrittenManifest().carried).toEqual({});
  });

  it('stops at the time budget and still writes the manifest', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      if (requestedPath(input) === '/') return new Response(shell(chunk('entry-n1')));
      // Hang until the budget aborts the request.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };

    const result = await carryOverChunks({
      exportDir,
      liveOrigin: LIVE,
      maxAgeDays: 3,
      maxFiles: 4000,
      budgetMs: 50,
      nowMs: NOW_MS,
      fetchImpl,
      warn: (message: string) => warnings.push(message),
    });

    expect(result.carriedCount).toBe(0);
    expect(result.manifestWritten).toBe(true);
    expect(existsSync(join(exportDir, chunk('entry-n1')))).toBe(false);
    expect(warnings.some((message) => message.includes('time budget'))).toBe(true);
  });

  it('keeps the newest files when --max-files is reached', async () => {
    const fetchImpl = liveSite({
      '/': html(shell(chunk('entry-n1'))),
      [chunk('entry-n1')]: js('entry'),
      '/chunk-carryover.json': {
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          current: [chunk('entry-n1')],
          carried: {
            [chunk('older')]: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
            [chunk('newer')]: new Date(NOW_MS - DAY_MS).toISOString(),
          },
        }),
      },
      [chunk('older')]: js('older'),
      [chunk('newer')]: js('newer'),
    });

    const result = await carryOverChunks({
      exportDir,
      liveOrigin: LIVE,
      maxAgeDays: 3,
      maxFiles: 2,
      concurrency: 1,
      nowMs: NOW_MS,
      fetchImpl,
      warn: (message: string) => warnings.push(message),
    });

    expect(result.carriedCount).toBe(2);
    expect(existsSync(join(exportDir, chunk('entry-n1')))).toBe(true);
    expect(existsSync(join(exportDir, chunk('newer')))).toBe(true);
    expect(existsSync(join(exportDir, chunk('older')))).toBe(false);
    expect(warnings.some((message) => message.includes('--max-files'))).toBe(true);
  });

  it('keeps the newest files when an older download finishes first', async () => {
    // Codex review on #6860: with eight downloads in flight, a slow live entry
    // used to lose its slot to older files that happened to finish sooner.
    const fetchImpl = withSlowPaths(
      liveSite({
        '/': html(shell(chunk('entry-n1'))),
        [chunk('entry-n1')]: js('entry'),
        '/chunk-carryover.json': {
          contentType: 'application/json',
          body: JSON.stringify({
            version: 1,
            current: [chunk('entry-n1')],
            carried: {
              [chunk('older')]: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
              [chunk('newer')]: new Date(NOW_MS - DAY_MS).toISOString(),
            },
          }),
        },
        [chunk('older')]: js('older'),
        [chunk('newer')]: js('newer'),
      }),
      { [chunk('entry-n1')]: 30 },
    );

    const result = await run(fetchImpl, { maxFiles: 2 });

    expect(result.carriedCount).toBe(2);
    expect(existsSync(join(exportDir, chunk('entry-n1')))).toBe(true);
    expect(existsSync(join(exportDir, chunk('newer')))).toBe(true);
    expect(existsSync(join(exportDir, chunk('older')))).toBe(false);
    expect(Object.keys(readWrittenManifest().carried).sort()).toEqual([chunk('entry-n1'), chunk('newer')].sort());
    expect(result.previousEntry).toBe(chunk('entry-n1'));
  });

  it('lets a route the live entry names replace an older file that filled the cap first', async () => {
    // The route is only discovered once the slow entry lands, after the older
    // carried file already took the last slot.
    const fetchImpl = withSlowPaths(
      liveSite({
        '/': html(shell(chunk('entry-n1'))),
        [chunk('entry-n1')]: js(`import("${chunk('route-a')}")`),
        [chunk('route-a')]: js('route a'),
        '/chunk-carryover.json': {
          contentType: 'application/json',
          body: JSON.stringify({
            version: 1,
            current: [],
            carried: { [chunk('older')]: new Date(NOW_MS - DAY_MS).toISOString() },
          }),
        },
        [chunk('older')]: js('older'),
      }),
      { [chunk('entry-n1')]: 30 },
    );

    const result = await run(fetchImpl, { maxFiles: 2 });

    expect(result.carriedCount).toBe(2);
    expect(readExportChunk(chunk('entry-n1'))).toContain('route-a');
    expect(readExportChunk(chunk('route-a'))).toBe('route a');
    expect(existsSync(join(exportDir, chunk('older')))).toBe(false);
    expect(result.carriedBytes).toBe(Buffer.byteLength(`import("${chunk('route-a')}")`) + Buffer.byteLength('route a'));
    expect(warnings.some((message) => message.includes('--max-files'))).toBe(true);
  });
});
