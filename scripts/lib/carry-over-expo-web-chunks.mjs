#!/usr/bin/env node
// Copies the JS chunks of recent app.boardsesh.com deploys into a fresh Expo web
// export, so a tab opened before this deploy can still lazy-load its routes.
//
// Why this exists (#5780). Cloudflare Pages serves only the files in the
// current deployment. Every chunk name is content-hashed, so each deploy drops
// the previous deploy's chunks. A tab still running deploy N-1's entry keeps
// N-1's chunk map; its next lazy route load asks for a file that is gone, gets
// a 404 from functions/_middleware.ts, and has to reload (#5611 recovers it,
// but the climber still loses the screen they were on).
//
// How it works. Before publishing deploy N, this reads the live site itself:
//   1. The live shell's eager <script src> files, plus every chunk they name.
//      That is deploy N-1's JS set, and the only source on the first run.
//   2. The live `/chunk-carryover.json`, which deploy N-1 published. It lists
//      N-1's own build files and every older file N-1 carried, each with the
//      last time it was live. Entries older than --max-age-days are dropped.
// Each file is downloaded into the export unless a file of the same path is
// already there (same hash, same bytes: the fresh build always wins). The
// manifest for deploy N is then written into the export.
//
// It never fails the deploy. Any error (live site down, bad manifest, a chunk
// answered with HTML, the time budget running out) logs a warning, keeps what
// was already carried, and exits 0. Worst case the deploy ships the fresh
// export alone, which is exactly what it did before this script existed.
//
// The export's own checks (inspect-expo-web-export.mjs, the baked-env grep)
// run before this, so carried files never count toward the eager budget.

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_PREFIX = '[carry-over-expo-web-chunks]';

/** Where Metro writes web JS chunks, relative to the export root. */
export const CHUNK_DIRECTORY = '/_expo/static/js/web/';

/** The manifest's published path. `_headers` marks it no-store. */
export const MANIFEST_PATH = '/chunk-carryover.json';

const MANIFEST_VERSION = 1;

// A factory, not a shared literal: a `/g` regex carries `lastIndex` between
// uses. Same pattern inspect-expo-web-export.mjs uses for chunk references.
const chunkReferencePattern = () => /["'`](\/_expo\/static\/js\/web\/[A-Za-z0-9._-]+\.js)["'`]/g;
const scriptSourcePattern = () => /<script[^>]+src="([^"]+\.js)"/g;
const SAFE_CHUNK_PATH = /^\/_expo\/static\/js\/web\/[A-Za-z0-9._-]+\.js$/;

/** True for a root-relative chunk path this script is willing to write to disk. */
export function isChunkPath(candidatePath) {
  return typeof candidatePath === 'string' && SAFE_CHUNK_PATH.test(candidatePath) && !candidatePath.includes('..');
}

/** Every chunk path a bundle's source names, in first-seen order. */
export function collectChunkRefs(bundleSource) {
  const chunkPaths = new Set();
  for (const match of bundleSource.matchAll(chunkReferencePattern())) {
    chunkPaths.add(match[1]);
  }
  return [...chunkPaths];
}

/** The shell's eager `<script src>` chunk paths, in document order. */
export function collectEagerScripts(shellHtml) {
  const scriptPaths = [];
  for (const match of shellHtml.matchAll(scriptSourcePattern())) {
    let scriptPath = match[1];
    // An absolute URL on the same site still names a file in the deployment.
    if (/^https?:\/\//i.test(scriptPath)) {
      try {
        scriptPath = new URL(scriptPath).pathname;
      } catch {
        continue;
      }
    }
    if (isChunkPath(scriptPath) && !scriptPaths.includes(scriptPath)) scriptPaths.push(scriptPath);
  }
  return scriptPaths;
}

/**
 * Parse a published manifest. Anything unreadable is an empty manifest: a 404
 * answered by the SPA fallback (HTML), a truncated body, an unknown version.
 * That is also the first-run bootstrap.
 *
 * @returns {{ current: string[], carried: Map<string, number> }}
 */
export function parseCarryoverManifest(manifestText) {
  const empty = { current: [], carried: new Map() };
  if (typeof manifestText !== 'string' || manifestText.trim() === '') return empty;
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== MANIFEST_VERSION) return empty;

  const current = Array.isArray(parsed.current) ? parsed.current.filter(isChunkPath) : [];
  const carried = new Map();
  if (parsed.carried && typeof parsed.carried === 'object') {
    for (const [chunkPath, lastLiveAt] of Object.entries(parsed.carried)) {
      const lastLiveAtMs = typeof lastLiveAt === 'string' ? Date.parse(lastLiveAt) : Number.NaN;
      if (isChunkPath(chunkPath) && Number.isFinite(lastLiveAtMs)) carried.set(chunkPath, lastLiveAtMs);
    }
  }
  return { current, carried };
}

/**
 * The carry order: newest first, then by path so ties are deterministic.
 * Negative when `left` should be kept ahead of `right`.
 */
export function compareCarryRank(left, right) {
  return right.lastLiveAtMs - left.lastLiveAtMs || left.path.localeCompare(right.path);
}

/**
 * Which files to try to carry, newest first. A file the live deployment serves
 * right now (its eager scripts, or the manifest's `current` list) was live
 * until this moment, so it gets `nowMs`. A file the live deployment itself
 * carried keeps its own timestamp and is dropped once it is older than the cap.
 *
 * @returns {Array<{ path: string, lastLiveAtMs: number }>}
 */
export function selectCarryCandidates({ livePaths, manifest, nowMs, maxAgeMs }) {
  const lastLiveAtByPath = new Map();
  for (const livePath of [...livePaths, ...manifest.current]) {
    if (isChunkPath(livePath)) lastLiveAtByPath.set(livePath, nowMs);
  }
  for (const [carriedPath, lastLiveAtMs] of manifest.carried) {
    if (lastLiveAtByPath.has(carriedPath)) continue;
    if (nowMs - lastLiveAtMs > maxAgeMs) continue;
    lastLiveAtByPath.set(carriedPath, Math.min(lastLiveAtMs, nowMs));
  }
  return [...lastLiveAtByPath]
    .map(([candidatePath, lastLiveAtMs]) => ({ path: candidatePath, lastLiveAtMs }))
    .sort(compareCarryRank);
}

/**
 * Is this response really the chunk? A missing chunk comes back as a 404 from
 * the asset Function, or, if that Function is ever out of the path, as the HTML
 * shell with a 200. Carrying either would publish HTML under a .js name.
 */
export function isJavaScriptResponse({ status, contentType, bodyStart }) {
  if (status !== 200) return false;
  if (!/javascript/i.test(contentType ?? '')) return false;
  return !bodyStart.trimStart().startsWith('<');
}

/** The manifest this deploy publishes for the next one. */
export function buildCarryoverManifest({ currentPaths, carried, nowMs }) {
  const carriedEntries = [...carried]
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([carriedPath, lastLiveAtMs]) => [carriedPath, new Date(lastLiveAtMs).toISOString()]);
  return {
    version: MANIFEST_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    current: [...currentPaths].sort((leftPath, rightPath) => leftPath.localeCompare(rightPath)),
    carried: Object.fromEntries(carriedEntries),
  };
}

/** Every JS chunk the fresh build wrote, as root-relative paths. */
export function listExportChunks(exportDir) {
  const chunkDirectory = join(exportDir, CHUNK_DIRECTORY);
  if (!existsSync(chunkDirectory)) return [];
  return readdirSync(chunkDirectory)
    .map((fileName) => `${CHUNK_DIRECTORY}${fileName}`)
    .filter(isChunkPath);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carry recent deploys' chunks into `exportDir` and write its manifest.
 * Never throws for anything the live site does; see the header.
 *
 * @param {{
 *   exportDir: string,
 *   liveOrigin: string,
 *   maxAgeDays: number,
 *   maxFiles: number,
 *   budgetMs?: number,
 *   requestTimeoutMs?: number,
 *   concurrency?: number,
 *   nowMs?: number,
 *   fetchImpl?: typeof fetch,
 *   warn?: (message: string) => void,
 * }} options
 * @returns {Promise<{ carriedCount: number, carriedBytes: number, previousEntry: string, manifestWritten: boolean, warnings: string[] }>}
 */
export async function carryOverChunks({
  exportDir,
  liveOrigin,
  maxAgeDays,
  maxFiles,
  budgetMs = 60_000,
  requestTimeoutMs = 20_000,
  concurrency = 8,
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
  warn = (message) => console.warn(`::warning::${LOG_PREFIX} ${message}`),
}) {
  const warnings = [];
  const recordWarning = (message) => {
    warnings.push(message);
    warn(message);
  };
  const origin = liveOrigin.replace(/\/+$/, '');
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const deadline = AbortSignal.timeout(budgetMs);
  const requestSignal = () => AbortSignal.any([deadline, AbortSignal.timeout(requestTimeoutMs)]);

  // Listed before anything is downloaded, so the manifest's `current` list is
  // only ever this build's own files.
  const currentPaths = listExportChunks(exportDir);
  const currentPathSet = new Set(currentPaths);
  /** @type {Map<string, number>} */
  const carried = new Map();
  let carriedBytes = 0;
  let previousEntry = '';

  try {
    let livePaths = [];
    try {
      const shellResponse = await fetchImpl(`${origin}/?carryover=${nowMs}`, {
        cache: 'no-store',
        signal: requestSignal(),
      });
      if (!shellResponse.ok) throw new Error(`live shell answered ${shellResponse.status}`);
      livePaths = collectEagerScripts(await shellResponse.text());
      if (livePaths.length === 0) recordWarning('the live shell names no /_expo chunk; nothing of it to carry');
    } catch (error) {
      recordWarning(`could not read the live shell at ${origin}/ (${errorMessage(error)})`);
    }

    // A 404 is the first run. Anything else that is not a manifest (a 5xx, a
    // 429, a dropped connection) loses every older file the live deploy carried,
    // so it gets one retry and then a warning.
    let manifest = parseCarryoverManifest('');
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const isLastAttempt = attempt === 2;
      try {
        const manifestResponse = await fetchImpl(`${origin}${MANIFEST_PATH}?carryover=${nowMs}&attempt=${attempt}`, {
          cache: 'no-store',
          signal: requestSignal(),
        });
        if (manifestResponse.ok) {
          manifest = parseCarryoverManifest(await manifestResponse.text());
          break;
        }
        if (manifestResponse.status === 404) break;
        if (isLastAttempt) {
          recordWarning(
            `${MANIFEST_PATH} answered ${manifestResponse.status} twice; older deploys' files drop out, carrying only the live deploy`,
          );
        }
      } catch (error) {
        if (isLastAttempt || deadline.aborted) {
          recordWarning(`could not read ${MANIFEST_PATH} (${errorMessage(error)}); carrying only the live deploy`);
          break;
        }
      }
    }

    const pending = selectCarryCandidates({ livePaths, manifest, nowMs, maxAgeMs });
    const seen = new Set(pending.map((candidate) => candidate.path));
    let skippedForCap = 0;
    let cutOffByBudget = 0;

    // Downloads finish in whatever order the network gives, and a carried chunk
    // can name newer files nothing listed yet. So the cap is enforced against
    // the carried set's lowest-ranked file, never by first come, first kept:
    // a newer file that lands once the cap is full replaces the oldest one.
    /** @type {Map<string, number>} */
    const carriedSizes = new Map();
    const lowestRankedCarried = () => {
      let lowest;
      for (const [carriedPath, carriedLastLiveAtMs] of carried) {
        const candidate = { path: carriedPath, lastLiveAtMs: carriedLastLiveAtMs };
        if (!lowest || compareCarryRank(candidate, lowest) > 0) lowest = candidate;
      }
      return lowest;
    };
    /** True when the cap is full and `candidate` ranks below every carried file. */
    const losesToCap = (candidate) => {
      if (carried.size < maxFiles) return false;
      const lowest = lowestRankedCarried();
      return !lowest || compareCarryRank(candidate, lowest) > 0;
    };

    const carryOne = async ({ path: chunkPath, lastLiveAtMs }) => {
      // Same name means same hash means same bytes. The fresh build wins.
      if (currentPathSet.has(chunkPath) || existsSync(join(exportDir, chunkPath))) return;
      if (losesToCap({ path: chunkPath, lastLiveAtMs })) {
        skippedForCap += 1;
        return;
      }
      let response;
      let body;
      try {
        response = await fetchImpl(`${origin}${chunkPath}`, { signal: requestSignal() });
        body = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (deadline.aborted) {
          cutOffByBudget += 1;
          return;
        }
        recordWarning(`dropped ${chunkPath}: ${errorMessage(error)}`);
        return;
      }
      const bodyStart = body.subarray(0, 64).toString('utf8');
      const contentType = response.headers.get('content-type') ?? '';
      if (!isJavaScriptResponse({ status: response.status, contentType, bodyStart })) {
        recordWarning(`dropped ${chunkPath}: answered ${response.status} ${contentType || '(no content-type)'}`);
        return;
      }
      // Re-check the cap: other workers may have filled it while this one
      // was downloading. A newer file takes the oldest carried file's slot.
      if (losesToCap({ path: chunkPath, lastLiveAtMs })) {
        skippedForCap += 1;
        return;
      }
      if (carried.size >= maxFiles) {
        const evicted = lowestRankedCarried();
        rmSync(join(exportDir, evicted.path), { force: true });
        carried.delete(evicted.path);
        carriedBytes -= carriedSizes.get(evicted.path) ?? 0;
        carriedSizes.delete(evicted.path);
        skippedForCap += 1;
      }
      const targetPath = join(exportDir, chunkPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, body);
      carried.set(chunkPath, lastLiveAtMs);
      carriedSizes.set(chunkPath, body.length);
      carriedBytes += body.length;

      // A carried chunk can name chunks of its own deploy that nothing above
      // listed (the first run has no manifest). They were live as long as it was.
      // Inserted in age order, so --max-files still keeps the newest.
      for (const referencedPath of collectChunkRefs(body.toString('utf8'))) {
        if (seen.has(referencedPath)) continue;
        seen.add(referencedPath);
        const olderIndex = pending.findIndex((candidate) => candidate.lastLiveAtMs < lastLiveAtMs);
        pending.splice(olderIndex === -1 ? pending.length : olderIndex, 0, { path: referencedPath, lastLiveAtMs });
      }
    };

    // An empty queue is not the end while another worker is still downloading:
    // that file can name more chunks (on the first run the queue starts with
    // only the shell's eager scripts). Idle workers wait for a download to
    // finish and stop only once nothing is queued and nothing is in flight.
    let inFlight = 0;
    let idleWorkers = [];
    const wakeIdleWorkers = () => {
      const waking = idleWorkers;
      idleWorkers = [];
      for (const wake of waking) wake();
    };
    const worker = async () => {
      while (!deadline.aborted) {
        const next = pending.shift();
        if (!next) {
          if (inFlight === 0) break;
          await new Promise((resolve) => idleWorkers.push(resolve));
          continue;
        }
        inFlight += 1;
        try {
          await carryOne(next);
        } finally {
          inFlight -= 1;
          wakeIdleWorkers();
        }
      }
      wakeIdleWorkers();
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

    cutOffByBudget += deadline.aborted ? pending.length : 0;
    if (cutOffByBudget > 0) {
      recordWarning(
        `time budget of ${budgetMs} ms ran out with ${cutOffByBudget} file(s) not carried; publishing what was carried`,
      );
    }
    if (skippedForCap > 0) {
      recordWarning(`--max-files ${maxFiles} reached; ${skippedForCap} older file(s) not carried`);
    }

    // Only claim a previous entry the deployment will really serve, so the
    // post-deploy smoke checks something this run put there.
    // The shell's first script is Metro's runtime; the entry is what a stale
    // tab actually booted from, so prefer it.
    const liveEntry = livePaths.find((livePath) => /\/entry-[^/]*\.js$/.test(livePath)) ?? livePaths[0];
    if (liveEntry && (carried.has(liveEntry) || existsSync(join(exportDir, liveEntry)))) previousEntry = liveEntry;
  } catch (error) {
    recordWarning(`carry-over stopped early (${errorMessage(error)}); publishing what was carried`);
  }

  let manifestWritten = false;
  try {
    const manifest = buildCarryoverManifest({ currentPaths, carried, nowMs });
    writeFileSync(join(exportDir, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
    manifestWritten = true;
  } catch (error) {
    recordWarning(`could not write ${MANIFEST_PATH} (${errorMessage(error)}); the next deploy will bootstrap`);
  }

  return { carriedCount: carried.size, carriedBytes, previousEntry, manifestWritten, warnings };
}

/** A positive number flag, or the fallback when it is missing or malformed. */
function readNumberFlag(argv, name, fallback) {
  const flagIndex = argv.indexOf(name);
  const parsed = flagIndex === -1 ? Number.NaN : Number(argv[flagIndex + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(argv) {
  const [exportDir] = argv;
  if (!exportDir || exportDir.startsWith('--')) {
    console.error(
      `${LOG_PREFIX} usage: node scripts/lib/carry-over-expo-web-chunks.mjs <export-dir> --live <origin> [--max-age-days 3] [--max-files 4000]`,
    );
    process.exit(1);
  }
  const liveFlagIndex = argv.indexOf('--live');
  const liveOrigin = (liveFlagIndex === -1 ? undefined : argv[liveFlagIndex + 1]) ?? 'https://app.boardsesh.com';
  const maxAgeDays = readNumberFlag(argv, '--max-age-days', 3);
  const maxFiles = readNumberFlag(argv, '--max-files', 4000);
  const budgetMs = readNumberFlag(argv, '--budget-ms', 60_000);

  const result = await carryOverChunks({ exportDir, liveOrigin, maxAgeDays, maxFiles, budgetMs });
  console.log(
    `${LOG_PREFIX} carried ${result.carriedCount} file(s), ${result.carriedBytes.toLocaleString()} bytes; ` +
      `${result.warnings.length} warning(s); previous entry ${result.previousEntry || '(none)'}`,
  );
  const outputLine = `previous_entry=${result.previousEntry}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, outputLine);
  } else {
    process.stdout.write(outputLine);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // Exit 0 on anything, including a bug in this file. The deploy must go out.
  main(process.argv.slice(2)).catch((error) => {
    console.warn(`::warning::${LOG_PREFIX} ${errorMessage(error)}; publishing the fresh export alone`);
  });
}
