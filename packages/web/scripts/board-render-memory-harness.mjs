#!/usr/bin/env node
/**
 * Manual load harness for the backend `/render/board` endpoint. NOT wired into CI —
 * it needs a running server and a few minutes of wall clock.
 *
 * What it answers: does the render path still grow RSS without bound? It fires
 * two phases at the largest Kilter board (layout 5 / size 15 / set 24 →
 * 1080×2498, ~2.70 MP) with `include_background=1`:
 *
 *   phase 1 — 200 requests, a unique `frames` per request. Nothing can hit the
 *             byte cache, so every request pays a full WASM render + encode and
 *             only the board-photo base is shared. This is the shape that was
 *             OOM-killing the former Vercel function.
 *   phase 2 — 200 requests cycling 10 `frames` values, i.e. the steady state a
 *             warm list page produces. Should be almost all byte-cache hits.
 *
 * While requesting it samples the server process's VmRSS from /proc every
 * 500 ms and prints peak/final RSS plus p50/p95 latency per phase. A healthy
 * run: phase 2 latency an order of magnitude below phase 1, and final RSS close
 * to peak rather than climbing monotonically across phases.
 *
 * Usage (from anywhere in the repo):
 *
 *   vp run dev                      # or: bun run --filter=@boardsesh/web dev
 *   node packages/web/scripts/board-render-memory-harness.mjs
 *
 * Options:
 *   --base <url>        backend origin (default http://localhost:8080)
 *   --pid <pid>         server pid to sample; auto-detected from the listening
 *                       port when omitted (Linux /proc only)
 *   --requests <n>      requests per phase (default 200)
 *   --concurrency <n>   in-flight requests (default 8)
 *   --board <name> --layout <id> --size <id> --sets <csv>
 *   --thumbnail         request the thumbnail variant instead
 *
 * Compare a before/after by running it against the branch and against main.
 */

import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const hasFlag = (name) => args.includes(`--${name}`);

const baseUrl = flag('base', 'http://localhost:8080').replace(/\/$/, '');
const requestsPerPhase = Number(flag('requests', '200'));
const concurrency = Number(flag('concurrency', '8'));
const boardName = flag('board', 'kilter');
const layoutId = flag('layout', '5');
const sizeId = flag('size', '15');
const setIds = flag('sets', '24');
const thumbnail = hasFlag('thumbnail');
const SAMPLE_INTERVAL_MS = 500;

/** Build a frames string that renders `count` distinct holds. */
function framesFor(seed) {
  const holdId = 1000 + (seed % 500);
  return `p${holdId}r42p${holdId + 1}r43`;
}

function renderUrl(frames) {
  const params = new URLSearchParams({
    board_name: boardName,
    layout_id: layoutId,
    size_id: sizeId,
    set_ids: setIds,
    frames,
    include_background: '1',
  });
  if (thumbnail) params.set('thumbnail', '1');
  return `${baseUrl}/render/board?${params}`;
}

/** Read a process's resident set size in MB, or null if it's gone. */
function readRssMb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+) kB$/m);
    return match ? Number(match[1]) / 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Find the pid listening on the base URL's port by matching /proc/net/tcp
 * inodes against each process's open sockets. Linux only; returns null if it
 * can't tell (pass --pid then).
 */
function findListeningPid(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let lines;
    try {
      lines = readFileSync(table, 'utf8').split('\n').slice(1);
    } catch {
      continue;
    }
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      // 0A = TCP_LISTEN
      if (fields[3] !== '0A') continue;
      if (!fields[1].endsWith(`:${hexPort}`)) continue;
      inodes.add(fields[9]);
    }
  }
  if (inodes.size === 0) return null;

  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${entry}/fd/${fd}`);
        const match = target.match(/^socket:\[(\d+)\]$/);
        if (match && inodes.has(match[1])) return Number(entry);
      } catch {
        // fd vanished mid-scan
      }
    }
  }
  return null;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

/** Run `total` requests at fixed concurrency, returning latency stats. */
async function runPhase(label, framesForIndex, total) {
  const latencies = [];
  const statuses = new Map();
  const cacheStates = new Map();
  let next = 0;
  const started = Date.now();

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      const requestStarted = performance.now();
      try {
        const response = await fetch(renderUrl(framesForIndex(index)));
        const body = await response.arrayBuffer();
        latencies.push(performance.now() - requestStarted);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        const timing = response.headers.get('server-timing') ?? '';
        const cache = timing.match(/cache;desc=([a-z-]+)/)?.[1] ?? 'unknown';
        cacheStates.set(cache, (cacheStates.get(cache) ?? 0) + 1);
        if (body.byteLength === 0) console.warn(`empty body for request ${index}`);
      } catch (error) {
        latencies.push(performance.now() - requestStarted);
        statuses.set('error', (statuses.get('error') ?? 0) + 1);
        if (statuses.get('error') === 1) console.error(`  first error: ${error.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const sorted = [...latencies].sort((a, b) => a - b);
  const elapsedSeconds = (Date.now() - started) / 1000;
  console.log(`\n${label}`);
  console.log(`  requests      ${total} at concurrency ${concurrency} in ${elapsedSeconds.toFixed(1)}s`);
  console.log(`  throughput    ${(total / elapsedSeconds).toFixed(1)} req/s`);
  console.log(`  latency p50   ${percentile(sorted, 0.5).toFixed(0)} ms`);
  console.log(`  latency p95   ${percentile(sorted, 0.95).toFixed(0)} ms`);
  console.log(`  latency max   ${sorted.at(-1)?.toFixed(0) ?? 0} ms`);
  console.log(`  statuses      ${[...statuses].map(([code, count]) => `${code}×${count}`).join(' ')}`);
  console.log(`  cache         ${[...cacheStates].map(([state, count]) => `${state}×${count}`).join(' ')}`);
}

async function main() {
  const port = Number(new URL(baseUrl).port || (new URL(baseUrl).protocol === 'https:' ? 443 : 80));
  const pid = Number(flag('pid', '')) || findListeningPid(port);
  if (pid) {
    console.log(`Sampling RSS of pid ${pid} (port ${port}) every ${SAMPLE_INTERVAL_MS}ms`);
  } else {
    console.warn(`Could not find the server pid for port ${port} — pass --pid to enable RSS sampling.`);
  }

  const samples = [];
  const sampler = pid
    ? setInterval(() => {
        const rss = readRssMb(pid);
        if (rss !== null) samples.push(rss);
      }, SAMPLE_INTERVAL_MS)
    : null;

  const startRss = pid ? readRssMb(pid) : null;

  // Warm the process (JIT, WASM init, first board base) before measuring.
  await fetch(renderUrl(framesFor(999))).then((response) => response.arrayBuffer());

  await runPhase(
    'PHASE 1 — unique climb per request (byte cache always misses)',
    (index) => framesFor(index),
    requestsPerPhase,
  );
  const phaseOneSamples = samples.length;

  await runPhase(
    'PHASE 2 — 10 repeating climbs (steady-state list traffic)',
    (index) => framesFor(index % 10),
    requestsPerPhase,
  );

  if (sampler) clearInterval(sampler);

  if (samples.length > 0) {
    const peak = Math.max(...samples);
    const phaseOnePeak = Math.max(...samples.slice(0, phaseOneSamples || 1));
    console.log('\nRSS');
    console.log(`  start         ${startRss?.toFixed(1) ?? '?'} MB`);
    console.log(`  phase 1 peak  ${phaseOnePeak.toFixed(1)} MB`);
    console.log(`  peak          ${peak.toFixed(1)} MB`);
    console.log(`  final         ${samples.at(-1).toFixed(1)} MB`);
    console.log(`  samples       ${samples.length}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
