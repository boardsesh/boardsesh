import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TUTORIAL_SNAPSHOT_BUCKET, TUTORIAL_SNAPSHOT_PREFIX } from './snapshots';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPOSE_FILE = resolve(REPO_ROOT, 'scripts/lib/instructional-video/fixtures/compose.yml');
export const TUTORIAL_PRIMARY_ACCOUNT = { email: 'test@boardsesh.com', password: 'test', name: 'Alex' } as const;
export const TUTORIAL_CREW_ACCOUNT = {
  email: 'sam+tutorial@boardsesh.local',
  password: 'boardsesh-demo',
  name: 'Sam',
} as const;
export const TUTORIAL_SPRAY_SLUG = 'tutorial-spray-wall';
export const TUTORIAL_SPRAY_UUID = '63300000-0000-4000-8000-000000000004';
export type TutorialDemoPorts = { postgres: number; redis: number; s3: number; backend: number };
export type TutorialDemo = { backendUrl: string; env: NodeJS.ProcessEnv; stop: () => Promise<void> };

/** Explicit allowlist prevents inherited production DB, R2, telemetry or email credentials reaching the demo. */
export function tutorialDemoEnvironment(
  ports: TutorialDemoPorts,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const portList = Object.values(ports);
  if (
    portList.length !== 4 ||
    portList.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) ||
    new Set(portList).size !== 4
  )
    throw new Error('Tutorial demo requires four distinct valid local ports');
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, configured] of Object.entries(inherited)) {
    if (
      [
        'PATH',
        'HOME',
        'TMPDIR',
        'LANG',
        'SHELL',
        'USER',
        'JAVA_HOME',
        'ANDROID_HOME',
        'ANDROID_SDK_ROOT',
        'FFMPEG_BIN',
        'FFPROBE_BIN',
      ].includes(name)
    )
      environment[name] = configured;
  }
  return {
    ...environment,
    NODE_ENV: 'development',
    BOARD_IMAGES_ROOT: resolve(REPO_ROOT, 'packages/web/public'),
    DOTENV_CONFIG_PATH: '/dev/null',
    BOARDSESH_TUTORIAL_DEMO: '1',
    BOARDSESH_PRIVACY_ENABLED: '1',
    DATABASE_URL: `postgresql://postgres:password@127.0.0.1:${ports.postgres}/boardsesh_tutorial`,
    READ_REPLICA_URL: '',
    REDIS_URL: `redis://127.0.0.1:${ports.redis}`,
    PORT: String(ports.backend),
    NEXTAUTH_SECRET: 'boardsesh-instructional-video-isolated-local-secret',
    BOARDSESH_URL: `http://127.0.0.1:${ports.backend}`,
    DB_POOL_MAX: '8',
    PRIVATE_S3_BUCKET_NAME: 'tutorial-private',
    PRIVATE_AWS_ENDPOINT_URL: `http://127.0.0.1:${ports.s3}`,
    PRIVATE_AWS_REGION: 'us-east-1',
    PRIVATE_AWS_ACCESS_KEY_ID: 'tutorial-local',
    PRIVATE_AWS_SECRET_ACCESS_KEY: 'tutorial-local',
    PRIVATE_S3_FORCE_PATH_STYLE: 'true',
    PRIVATE_DISABLE_ACL: 'true',
    SNAPSHOTS_S3_BUCKET_NAME: TUTORIAL_SNAPSHOT_BUCKET,
    SNAPSHOTS_AWS_ENDPOINT_URL: `http://127.0.0.1:${ports.s3}`,
    SNAPSHOTS_AWS_REGION: 'us-east-1',
    SNAPSHOTS_AWS_ACCESS_KEY_ID: 'tutorial-local',
    SNAPSHOTS_AWS_SECRET_ACCESS_KEY: 'tutorial-local',
    SNAPSHOTS_S3_FORCE_PATH_STYLE: 'true',
    SNAPSHOTS_DISABLE_ACL: 'true',
    SNAPSHOTS_PUBLIC_BASE_URL: `http://127.0.0.1:${ports.s3}/${TUTORIAL_SNAPSHOT_BUCKET}`,
    SNAPSHOT_PUBLIC_BASE_URL: `http://127.0.0.1:${ports.s3}/${TUTORIAL_SNAPSHOT_BUCKET}`,
    EXPO_PUBLIC_SNAPSHOT_BASE_URL: `http://127.0.0.1:${ports.s3}/${TUTORIAL_SNAPSHOT_BUCKET}/${TUTORIAL_SNAPSHOT_PREFIX}`,
    TUTORIAL_POSTGRES_PORT: String(ports.postgres),
    TUTORIAL_REDIS_PORT: String(ports.redis),
    TUTORIAL_S3_PORT: String(ports.s3),
    EXPO_PUBLIC_BACKEND_URL: `http://127.0.0.1:${ports.backend}`,
    EXPO_PUBLIC_WS_URL: `ws://127.0.0.1:${ports.backend}/graphql`,
    TUTORIAL_DEMO_EMAIL: TUTORIAL_PRIMARY_ACCOUNT.email,
    TUTORIAL_DEMO_PASSWORD: TUTORIAL_PRIMARY_ACCOUNT.password,
    EXPO_PUBLIC_SCREENSHOT_BOARDS: 'Tutorial Kilter|Tutorial Tension|Tutorial MoonBoard|Tutorial Spray Wall',
    TUTORIAL_CREW_USER_ID: '63300000-0000-4000-8000-000000000002',
    TUTORIAL_CREW_EMAIL: TUTORIAL_CREW_ACCOUNT.email,
    TUTORIAL_CREW_PASSWORD: TUTORIAL_CREW_ACCOUNT.password,
    TUTORIAL_SPRAY_SLUG,
    TUTORIAL_SPRAY_UUID,
    TUTORIAL_BOARD_ANGLE: '40',
  };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot allocate tutorial port');
  await new Promise<void>((accept, reject) => server.close((error) => (error ? reject(error) : accept())));
  return address.port;
}

/** Stop the exact owned command group before rejecting cancellation; cleanup callers omit the signal. */
export async function runTutorialDemoCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logPath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const log = createWriteStream(logPath, { flags: 'a' });
  let stdout = '';
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      signal?.removeEventListener('abort', abort);
      if (killTimeout) clearTimeout(killTimeout);
    };
    const abort = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          child.kill('SIGTERM');
        }
      }
      const ownedProcessGroup = child.pid;
      killTimeout = setTimeout(() => {
        // A wrapper can exit while a descendant retains its pipes and ignores SIGTERM.
        if (ownedProcessGroup) {
          try {
            process.kill(-ownedProcessGroup, 'SIGKILL');
          } catch {
            /* command group already exited */
          }
        }
      }, 8000);
    };
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once('error', (error) => {
      clear();
      reject(error);
    });
    child.once('close', (code) => {
      clear();
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) accept();
      else reject(new Error(`${command} ${args.join(' ')} failed (${code}); inspect ${logPath}`));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  }).finally(() => log.end());
  return stdout;
}

const run = runTutorialDemoCommand;

async function waitForHttp(url: string, child?: ChildProcess, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error('Tutorial backend exited before becoming ready');
    try {
      const deadlineSignal = AbortSignal.timeout(2000);
      if ((await fetch(url, { signal: signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal })).ok)
        return;
    } catch {
      signal?.throwIfAborted();
      /* service still starting */
    }
    await new Promise((accept) => setTimeout(accept, 500));
  }
  throw new Error(`Tutorial service did not become ready: ${url}`);
}

/** Start only the named tutorial Compose project. stop retains all database volumes and seeded history. */
export async function startTutorialDemo(workRoot: string, signal?: AbortSignal): Promise<TutorialDemo> {
  signal?.throwIfAborted();
  const demoRoot = resolve(workRoot, 'demo');
  await mkdir(demoRoot, { recursive: true });
  const project = `boardsesh-tutorial-${createHash('sha256').update(demoRoot).digest('hex').slice(0, 10)}`;
  const lockPath = resolve(demoRoot, 'running.lock');
  // Fail on another capture instead of stopping its infrastructure underneath it.
  try {
    await writeFile(lockPath, String(process.pid), { flag: 'wx' });
  } catch {
    throw new Error(
      `Tutorial demo is already owned by a capture: ${lockPath}. Verify that process has stopped before removing its stale lock.`,
    );
  }
  const portsPath = resolve(demoRoot, 'ports.json');
  const logPath = resolve(demoRoot, 'runtime.log');
  let ports: TutorialDemoPorts;
  try {
    ports = JSON.parse(await readFile(portsPath, 'utf8')) as TutorialDemoPorts;
  } catch {
    ports = {
      postgres: await unusedPort(),
      redis: await unusedPort(),
      s3: await unusedPort(),
      backend: await unusedPort(),
    };
    await writeFile(portsPath, `${JSON.stringify(ports)}\n`);
  }
  const env = tutorialDemoEnvironment(ports);
  const compose = ['compose', '-p', project, '-f', COMPOSE_FILE];
  let backend: ChildProcess | undefined;
  let stopped = false;
  let startedInfrastructure = false;
  const backendLog = createWriteStream(logPath, { flags: 'a' });
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      try {
        if (backend?.pid && backend.exitCode === null && backend.signalCode === null) {
          const child = backend;
          try {
            process.kill(-backend.pid, 'SIGTERM');
          } catch (error: unknown) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
          }
          await new Promise<void>((accept) => {
            const timeout = setTimeout(() => {
              if (child.pid && child.exitCode === null && child.signalCode === null) {
                try {
                  process.kill(-child.pid, 'SIGKILL');
                } catch {
                  /* exited */
                }
              }
              accept();
            }, 12_000);
            child.once('exit', () => {
              clearTimeout(timeout);
              accept();
            });
          });
        }
      } finally {
        if (startedInfrastructure) await run('docker', [...compose, 'stop'], env, logPath);
      }
    } finally {
      backendLog.end();
      await unlink(lockPath);
    }
  };
  try {
    signal?.throwIfAborted();
    // Required tester-facing notes are written before the backend is started.
    const qaNotes = resolve(demoRoot, 'qa-notes.md');
    await writeFile(
      qaNotes,
      '1. Open Tutorial Kilter; queue a climb and invite Sam. Both climbers appear.\n2. Start a workout; log a go. Rest counts down and the next climb appears.\n3. Download the board; paint holds. Matching climbs and a heatmap appear.\n4. Open Tutorial Spray Wall. The wall photograph and highlighted holds appear.\n5. Open You; compare board filters and personal grades. Recorded progress appears.\n',
    );
    env.BOARDSESH_DEV_QA_NOTES_FILE = qaNotes;
    env.EXPO_PUBLIC_QA_NOTES_FILE = qaNotes;
    env.TUTORIAL_QA_NOTES_FILE = qaNotes;
    console.info(`[tutorial-demo] QA notes: ${qaNotes}`);
    startedInfrastructure = true;
    await run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '300'], env, logPath, signal);
    await waitForHttp(`http://127.0.0.1:${ports.s3}/`, undefined, signal);
    // The baked development image already contains main; POSTGRES_DB cannot rename an initialized cluster.
    const databaseExists = await run(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-tAc',
        "SELECT 1 FROM pg_database WHERE datname = 'boardsesh_tutorial'",
      ],
      env,
      logPath,
      signal,
    );
    if (databaseExists.trim() !== '1')
      await run(
        'docker',
        [...compose, 'exec', '-T', 'postgres', 'createdb', '-U', 'postgres', '-T', 'main', 'boardsesh_tutorial'],
        env,
        logPath,
        signal,
      );
    await run('vp', ['exec', 'tsx', 'packages/db/scripts/migrate-instructional-video.ts'], env, logPath, signal);
    const seedPath = resolve(demoRoot, 'seed.json');
    await run(
      'vp',
      ['exec', 'tsx', 'packages/backend/src/scripts/seed-instructional-video.ts', REPO_ROOT, seedPath],
      env,
      logPath,
      signal,
    );
    // Cloning the baked database leaves planner statistics empty. Refresh them before native profile reads.
    await run(
      'docker',
      [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'boardsesh_tutorial', '-c', 'ANALYZE'],
      env,
      logPath,
      signal,
    );
    const snapshotDirectory = resolve(demoRoot, 'snapshots');
    await run(
      'vp',
      ['exec', 'tsx', 'scripts/prepare-instructional-video-snapshots.ts', REPO_ROOT, seedPath, snapshotDirectory],
      env,
      logPath,
      signal,
    );
    // The exact real artifact identity participates in per-take capture fingerprints through the scenario.
    const seedDocument = JSON.parse(await readFile(seedPath, 'utf8')) as Record<string, unknown>;
    seedDocument.offlineSnapshot = JSON.parse(
      await readFile(resolve(snapshotDirectory, 'receipt.json'), 'utf8'),
    ) as unknown;
    await writeFile(seedPath, `${JSON.stringify(seedDocument, null, 2)}\n`);
    env.TUTORIAL_SEED_FILE = seedPath;
    const seed = JSON.parse(await readFile(seedPath, 'utf8')) as {
      fixtureFingerprint: string;
      boards: { boardType: string; layoutId: number; sizeId: number; setIds: string }[];
    };
    const kilter = seed.boards.find((board) => board.boardType === 'kilter');
    if (!kilter) throw new Error('Tutorial seed has no Kilter board');
    env.TUTORIAL_BOARD_PATH = `kilter/${kilter.layoutId}/${kilter.sizeId}/${kilter.setIds}`;
    env.TUTORIAL_FIXTURE_FINGERPRINT = seed.fixtureFingerprint;
    signal?.throwIfAborted();
    backend = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/backend/src/scripts/serve-instructional-video.ts'],
      {
        cwd: REPO_ROOT,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    backend.stdout?.pipe(backendLog, { end: false });
    backend.stderr?.pipe(backendLog, { end: false });
    let spawnError: Error | undefined;
    backend.once('error', (error) => {
      spawnError = error;
    });
    const backendUrl = `http://127.0.0.1:${ports.backend}`;
    await waitForHttp(`${backendUrl}/health`, backend, signal);
    await waitForHttp(`${backendUrl}/health/db`, backend, signal);
    if (spawnError) throw spawnError;
    signal?.throwIfAborted();
    return { backendUrl, env, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
