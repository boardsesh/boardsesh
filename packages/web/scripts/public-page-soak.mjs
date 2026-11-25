import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const standalone = option('standalone-dir');
const pathsFile = option('paths-file');
if (!standalone || !pathsFile) {
  throw new Error(
    'Pass --standalone-dir <built standalone/packages/web> and --paths-file <JSON array of real climb paths>',
  );
}
const minutes = Number(option('minutes', '60'));
const requestsPerMinute = Number(option('requests-per-minute', '800'));
const maximumOutstanding = 64;
if (!Number.isFinite(minutes) || minutes < 1 || !Number.isFinite(requestsPerMinute) || requestsPerMinute < 1) {
  throw new Error('Soak duration and rate must be positive numbers');
}
const paths = JSON.parse(await readFile(pathsFile, 'utf8'));
if (
  !Array.isArray(paths) ||
  new Set(paths).size < 800 ||
  paths.some((path) => typeof path !== 'string' || !path.startsWith('/') || !path.includes('/view/'))
) {
  throw new Error('Supply at least 800 real public climb paths; fabricated 404s do not exercise climb rendering');
}

// Refuse production data even when the caller accidentally inherits a live shell.
const allowDockerHost = process.argv.includes('--allow-docker-host');
const localHosts = ['localhost', '127.0.0.1', '[::1]', ...(allowDockerHost ? ['host.docker.internal'] : [])];
for (const variable of [
  'DATABASE_URL',
  'READ_REPLICA_URL',
  'WEB_DATABASE_URL',
  'BACKEND_INTERNAL_URL',
  'NEXT_PUBLIC_WS_URL',
  'NEXT_PUBLIC_GRAPHQL_URL',
]) {
  const configured = process.env[variable];
  if (!configured) continue;
  const hostname = new URL(configured).hostname;
  if (!localHosts.includes(hostname)) throw new Error(`${variable} must point at an isolated loopback fixture`);
}
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the isolated seeded development database');
if (!process.env.BACKEND_INTERNAL_URL)
  throw new Error('Set BACKEND_INTERNAL_URL to the isolated development backend or a loopback fixture');

const reservation = createServer();
await new Promise((resolveListen, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolveListen);
});
const address = reservation.address();
if (!address || typeof address === 'string') throw new Error('Could not reserve the standalone port');
const port = address.port;
await new Promise((resolveClose) => reservation.close(resolveClose));
const origin = `http://127.0.0.1:${port}`;
const samples = [];
const output = resolve(option('output', 'public-page-soak.json'));
const server = fork(resolve(standalone, 'server.js'), [], {
  cwd: resolve(standalone),
  execArgv: [
    // Match the production process's roughly 1.95 GiB V8 heap on a large host.
    '--max-old-space-size=1900',
    '--expose-gc',
    '--require',
    resolve(option('guard-preload', fileURLToPath(new URL('./public-page-load-guard-preload.cjs', import.meta.url)))),
    '--require',
    fileURLToPath(new URL('./public-page-soak-sample.cjs', import.meta.url)),
  ],
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    NODE_ENV: 'production',
    SENTRY_ENVIRONMENT: 'test',
    PUBLIC_PAGE_SOAK_ALLOW_DOCKER_HOST: allowDockerHost ? '1' : '',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    NEXTAUTH_URL: 'https://soak.boardsesh.test',
    BASE_URL: 'https://soak.boardsesh.test',
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let fatal = null;
let logsTail = '';
for (const stream of [server.stdout, server.stderr])
  stream.on('data', (chunk) => {
    const text = chunk.toString();
    logsTail = (logsTail + text).slice(-8_192);
    if (/FATAL ERROR|heap out of memory/i.test(text)) fatal = 'JavaScript heap exhausted';
  });
server.on('message', (message) => {
  if (message?.type === 'public-page-soak-sample') samples.push(message);
});
server.once('exit', (code, signal) => {
  fatal ??= `Standalone exited: ${code ?? signal}`;
});
const statuses = {};
let attempted = 0;
let skipped = 0;
let transportErrors = 0;
let invalidClimbBodies = 0;
let peakOutstanding = 0;
const outstanding = new Set();
let sampler;
let producer;
try {
  const bootDeadline = Date.now() + 30_000;
  while (true) {
    if (fatal) throw new Error(fatal);
    try {
      const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      await health.body?.cancel();
      if (health.ok) break;
    } catch {}
    if (Date.now() > bootDeadline) throw new Error('Standalone did not become healthy');
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  server.send({ type: 'public-page-soak-sample', forceGc: false });
  let collectedRetentionBaseline = false;
  sampler = setInterval(() => {
    const forceGc = !collectedRetentionBaseline && performance.now() - startedAt >= 29.5 * 60_000;
    if (forceGc) collectedRetentionBaseline = true;
    server.send({ type: 'public-page-soak-sample', forceGc });
    process.stdout.write(
      JSON.stringify({
        elapsedMinutes: Math.round((performance.now() - startedAt) / 60_000),
        attempted,
        statuses,
        transportErrors,
        outstanding: outstanding.size,
        sample: samples.at(-1),
      }) + '\n',
    );
  }, 60_000);
  const startedAt = performance.now();
  const endAt = startedAt + minutes * 60_000;
  producer = setInterval(() => {
    if (fatal || performance.now() >= endAt) return;
    if (outstanding.size >= maximumOutstanding) {
      skipped += 1;
      return;
    }
    const path = paths[attempted % paths.length];
    const sequence = attempted++;
    const pending = fetch(`${origin}${path}`, {
      signal: AbortSignal.timeout(15_000),
      headers:
        sequence % 3 === 0
          ? { rsc: '1', 'user-agent': `Mozilla/5.0 Chrome/${120 + (sequence % 40)}.0.0.0 Safari/537.36` }
          : { 'user-agent': `Mozilla/5.0 Chrome/${120 + (sequence % 40)}.0.0.0 Safari/537.36` },
    })
      .then(async (response) => {
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        const body = await response.text();
        if (
          response.status === 200 &&
          (!body.includes('climb-similar-heading') || (!body.includes('<h1') && !body.includes('"h1"')))
        )
          invalidClimbBodies += 1;
      })
      .catch(() => {
        transportErrors += 1;
      })
      .finally(() => outstanding.delete(pending));
    outstanding.add(pending);
    peakOutstanding = Math.max(peakOutstanding, outstanding.size);
  }, 60_000 / requestsPerMinute);
  while (performance.now() < endAt && !fatal) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  clearInterval(producer);
  await Promise.allSettled(outstanding);
  server.send({ type: 'public-page-soak-sample', forceGc: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const finalWindow = samples.filter((sample) => sample.forcedGc && sample.timestamp >= Date.now() - 31 * 60_000);
  const retainedGrowthBytes =
    finalWindow.length > 1 ? finalWindow.at(-1).heapUsedBytes - finalWindow[0].heapUsedBytes : null;
  const passed =
    !fatal &&
    minutes >= 60 &&
    finalWindow.length >= 2 &&
    retainedGrowthBytes <= 64 * 1024 * 1024 &&
    transportErrors === 0 &&
    invalidClimbBodies === 0 &&
    !statuses[500] &&
    !statuses[502] &&
    (statuses[200] ?? 0) > attempted * 0.5 &&
    samples.every((sample) => (sample.guard?.active ?? 0) <= 16);
  const report = {
    passed,
    minutes,
    requestsPerMinute,
    distinctPaths: paths.length,
    attempted,
    skipped,
    statuses,
    transportErrors,
    invalidClimbBodies,
    peakOutstanding,
    retainedGrowthBytes,
    fatal,
    samples,
    logsTail,
  };
  await writeFile(output, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ passed, output, attempted, statuses, retainedGrowthBytes, fatal }) + '\n');
  if (!passed) process.exitCode = 1;
} finally {
  clearInterval(producer);
  clearInterval(sampler);
  server.kill('SIGTERM');
  const force = setTimeout(() => server.kill('SIGKILL'), 10_000);
  force.unref();
  await new Promise((resolveExit) => {
    if (server.exitCode !== null || server.signalCode !== null) resolveExit();
    else server.once('exit', resolveExit);
  });
  clearTimeout(force);
}
