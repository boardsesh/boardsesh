import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrewParticipant } from './capture-crew';
import { tutorialModifiedSourcePaths } from './source';
import {
  assertLocalTutorialBackend,
  measureTutorialScreen,
  trimTutorialAnchors,
  tutorialCaptureFingerprint,
  tutorialManifestProblems,
} from './capture-contract';
export {
  assertLocalTutorialBackend,
  measureTutorialScreen,
  trimTutorialAnchors,
  tutorialCaptureFingerprint,
  tutorialManifestProblems,
} from './capture-contract';
import { JOIN_SESSION, ADD_QUEUE_ITEM } from '../../../packages/shared/graphql/src/operations/queue-session';
import { androidEnv, adbPath, avdmanagerPath, emulatorPath, resolveAndroidHome } from '../android-sdk';
import {
  androidDevClientUrl,
  buildDemoModeCommands,
  buildScreenrecordArgs,
  isScreenrecordStartedLine,
  showcaseSystemImage,
} from '../showcase-video/android';
import { parseShowcaseAnchorLine } from '../showcase-video/contract';
import type { TutorialAnchor, TutorialCaptureOptions, TutorialTakeManifest } from './types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const APP = 'com.boardsesh.app.dev';
const AVD = 'Boardsesh_Tutorial';
const PORT = 5584;
const sleep = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));
const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

function command(
  binary: string,
  argumentsList: string[],
  env: NodeJS.ProcessEnv,
  timeout = 60_000,
  input?: string,
): string {
  const result = spawnSync(binary, argumentsList, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    input,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${binary} ${argumentsList.slice(0, 3).join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  return result.stdout;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGINT');
    } catch {
      child.kill('SIGINT');
    }
  }
  await Promise.race([new Promise<void>((done) => child.once('exit', () => done())), sleep(8000)]);
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout: number, description: string): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeout / 1000}s waiting for ${description}.`);
}

export async function captureTutorial(options: TutorialCaptureOptions): Promise<void> {
  if (options.platform !== 'android')
    throw new Error('iOS capture is tracked in the iOS sub-issue; this recorder supports Linux Android.');
  const env = androidEnv(options.env ?? process.env);
  const backend = assertLocalTutorialBackend(options.backendUrl ?? env.EXPO_PUBLIC_BACKEND_URL ?? '');
  const adb = adbPath(resolveAndroidHome());
  const work = join(options.workRoot, 'work', 'android');
  mkdirSync(work, { recursive: true });
  const apk = options.apkPath ?? env.TUTORIAL_ANDROID_APK;
  if (!apk || !existsSync(apk))
    throw new Error('Supply --apk-path or TUTORIAL_ANDROID_APK with the cached Android dev-client APK.');
  const nativeArtifactSha256 = sha(readFileSync(apk));
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], env).trim();
  const captureSource = createHash('sha256');
  const captureSources = new Set([
    ...command(
      'git',
      [
        'ls-files',
        'packages/mobile/app',
        'packages/mobile/src',
        'packages/shared',
        'packages/shared-schema',
        'packages/board-constants',
        'scripts/lib/android-sdk.ts',
        'scripts/lib/showcase-video/android.ts',
        'scripts/lib/showcase-video/contract.ts',
      ],
      env,
    )
      .trim()
      .split('\n'),
    'scripts/lib/instructional-video/capture.ts',
    'scripts/lib/instructional-video/capture-crew.ts',
    'scripts/lib/instructional-video/capture-contract.ts',
  ]);
  for (const path of [...captureSources].sort())
    if (existsSync(resolve(ROOT, path))) captureSource.update(path).update(readFileSync(resolve(ROOT, path)));
  const captureSourceSha256 = captureSource.digest('hex');
  const selectedTakes = options.episode.takes.filter(
    (take) => !options.chapterIds || options.chapterIds.includes(take.chapterId),
  );
  const serial = options.serial ?? `emulator-${PORT}`;
  let emulator: ChildProcess | undefined;
  let metro: ChildProcess | undefined;
  let crew: CrewParticipant | undefined;
  const marks = new Map<string, number>();
  const signals = new Set<string>();
  const signalValues = new Map<string, string>();
  let crewAdd: (() => Promise<void>) | undefined;
  let signalFailure: Error | undefined;
  const metroLog = join(work, 'metro.log');
  let timerSessionId: string | undefined;
  let timerCurrentUuid: string | undefined;
  let primaryJwt: string | undefined;
  let activeSession = false;
  let sessionTeardown: (() => Promise<void>) | undefined;
  const server = createServer((request, response) => {
    const [kind, name] = (request.url ?? '').split('?')[0].split('/').slice(1);
    if (!name || !/^[a-z0-9-]{1,64}$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    const sessionCurrent = async (sessionId: string) => {
      const result = await fetch(new URL('/graphql', backend), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${primaryJwt}` },
        body: JSON.stringify({
          query: 'query($id:ID!){session(sessionId:$id){queueState{currentClimbQueueItem{climb{uuid}}}}}',
          variables: { id: sessionId },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await result.json()) as {
        data?: { session?: { queueState: { currentClimbQueueItem?: { climb: { uuid: string } } } } };
        errors?: unknown;
      };
      if (!result.ok || body.errors) throw new Error('Could not read authoritative workout queue.');
      return body.data?.session?.queueState.currentClimbQueueItem?.climb.uuid;
    };
    if (kind === 'mark') {
      marks.set(name, Date.now());
      if (name === 'logged') {
        void (async () => {
          const result = await fetch(new URL('/graphql', backend), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${primaryJwt}` },
            body: JSON.stringify({ query: '{mySessions{id isActive createdAt boardPath}}' }),
            signal: AbortSignal.timeout(5000),
          });
          const body = (await result.json()) as {
            data?: { mySessions: { id: string; isActive: boolean; createdAt: string; boardPath: string }[] };
            errors?: unknown;
          };
          if (!result.ok || body.errors) throw new Error('Could not discover the active workout session.');
          const active = (body.data?.mySessions ?? [])
            .filter(
              (session) =>
                session.isActive &&
                (!env.TUTORIAL_BOARD_PATH ||
                  session.boardPath === env.TUTORIAL_BOARD_PATH ||
                  session.boardPath.startsWith(`${env.TUTORIAL_BOARD_PATH}/`)),
            )
            .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
          if (active.length !== 1)
            throw new Error(`Expected one active tutorial workout session, received ${active.length}.`);
          timerSessionId = active[0].id;
          if (!timerSessionId) throw new Error('Workout has no active private session.');
          timerCurrentUuid = await sessionCurrent(timerSessionId);
          if (!timerCurrentUuid) throw new Error('Workout has no authoritative current climb.');
        })().catch((error: unknown) => {
          signalFailure = error instanceof Error ? error : new Error(String(error));
        });
      }
    }
    if (kind === 'signal' && name === 'timer-advanced') {
      void (async () => {
        const current = timerSessionId ? await sessionCurrent(timerSessionId) : undefined;
        response.end(current && timerCurrentUuid && current !== timerCurrentUuid ? 'go' : 'wait');
      })().catch((error: unknown) => {
        signalFailure = error instanceof Error ? error : new Error(String(error));
        response.writeHead(500).end('failed');
      });
      return;
    }
    if (kind === 'set') {
      signals.add(name);
      if (name === 'crew-add' && crewAdd) {
        const add = crewAdd;
        crewAdd = undefined;
        void add()
          .then(() => signals.add('crew-added'))
          .catch((error: unknown) => {
            signalFailure = error instanceof Error ? error : new Error(String(error));
          });
      }
    }
    response.end(
      kind === 'signal'
        ? signals.has(name)
          ? 'go'
          : 'wait'
        : kind === 'value'
          ? (signalValues.get(name) ?? '')
          : 'ok',
    );
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Signal server has no port');
  const signalUrl = `http://127.0.0.1:${address.port}`;
  const metroPort = Number(env.TUTORIAL_METRO_PORT ?? 8088);
  try {
    const readyDevices = command(adb, ['devices'], env)
      .split('\n')
      .filter((line) => line.endsWith('\tdevice'))
      .map((line) => line.split('\t')[0]);
    if (!readyDevices.includes(serial)) {
      if (options.serial) throw new Error(`Requested emulator ${serial} is not ready.`);
      const names = command(avdmanagerPath(resolveAndroidHome()), ['list', 'avd', '-c'], env);
      if (!names.split(/\r?\n/).includes(AVD))
        command(
          avdmanagerPath(resolveAndroidHome()),
          ['create', 'avd', '-n', AVD, '-k', showcaseSystemImage(process.arch), '-d', 'pixel_7'],
          env,
          60_000,
          'no\n',
        );
      const avdConfig = join(env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd'), `${AVD}.avd`, 'config.ini');
      const config = readFileSync(avdConfig, 'utf8');
      writeFileSync(
        avdConfig,
        config.replace(/^hw\.lcd\.(width|height|density)=.*\n/gm, '') +
          '\nhw.lcd.width=1080\nhw.lcd.height=2424\nhw.lcd.density=420\n',
      );
      const emulatorFd = openSync(join(work, 'emulator.log'), 'w');
      emulator = spawn(
        emulatorPath(resolveAndroidHome()),
        [
          '-avd',
          AVD,
          '-port',
          String(PORT),
          '-no-window',
          '-no-snapshot',
          '-no-audio',
          '-timezone',
          'Etc/UTC',
          '-cores',
          env.BOARDSESH_EMULATOR_CORES ?? '2',
          '-show-kernel',
          '-accel',
          env.BOARDSESH_EMULATOR_ACCEL ?? (existsSync('/dev/kvm') ? 'auto' : 'off'),
          '-gpu',
          env.BOARDSESH_EMULATOR_GPU ?? 'swangle',
          '-feature',
          env.BOARDSESH_EMULATOR_FEATURES ?? '-Vulkan',
        ],
        { cwd: ROOT, env, detached: true, stdio: ['ignore', emulatorFd, emulatorFd] },
      );
      closeSync(emulatorFd);
      let emulatorError: Error | undefined;
      emulator.on('error', (error) => {
        emulatorError = error;
      });
      emulator.on('exit', (code, signal) => {
        emulatorError = new Error(
          `Tutorial emulator exited during boot (code=${code}, signal=${signal}); inspect ${join(work, 'emulator.log')}.`,
        );
      });
      await waitFor(
        () => {
          if (emulatorError) throw emulatorError;
          try {
            return command(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], env, 5000).trim() === '1';
          } catch {
            return false;
          }
        },
        Number(env.TUTORIAL_BOOT_TIMEOUT_MS ?? 900_000),
        'tutorial emulator boot',
      );
    }
    if (command(adb, ['-s', serial, 'emu', 'avd', 'name'], env).split(/\r?\n/)[0].trim() !== AVD)
      throw new Error(`Refusing to use ${serial}: capture must run on dedicated ${AVD} AVD.`);
    command(adb, ['-s', serial, 'install', '-r', '-g', resolve(apk)], env, 120_000);
    command(adb, ['-s', serial, 'shell', 'input', 'keyevent', '82'], env);
    for (const args of buildDemoModeCommands(serial)) command(adb, args, env);
    const geometry = measureTutorialScreen(
      command(adb, ['-s', serial, 'shell', 'wm', 'size'], env),
      command(adb, ['-s', serial, 'shell', 'wm', 'density'], env),
    );
    for (const port of new Set(
      [metroPort, Number(backend.port || 80), Number(env.TUTORIAL_S3_PORT || 0)].filter(Boolean),
    ))
      command(adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], env);
    const metroEnv: NodeJS.ProcessEnv = {
      ...env,
      CI: '1',
      BOARDSESH_APP_VARIANT: 'dev',
      EXPO_NO_DOTENV: '1',
      EXPO_PUBLIC_BACKEND_URL: backend.href.replace(/\/$/, ''),
      EXPO_PUBLIC_WS_URL: new URL('/graphql', backend).href.replace(/^http/, 'ws'),
      EXPO_PUBLIC_WEB_URL: backend.origin,
      EXPO_PUBLIC_SCREENSHOT_MODE: '1',
      EXPO_PUBLIC_SCREENSHOT_FAKE_BLE: '1',
      EXPO_PUBLIC_SCREENSHOT_THEME: 'dark',
      EXPO_PUBLIC_SCREENSHOT_LOCALE: 'en-US',
      EXPO_PUBLIC_SCREENSHOT_USER_EMAIL: env.TUTORIAL_DEMO_EMAIL ?? 'test@boardsesh.com',
      EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD: env.TUTORIAL_DEMO_PASSWORD ?? 'test',
    };
    for (const key of [
      'EXPO_PUBLIC_SCREENSHOT_NOW',
      'EXPO_PUBLIC_SCREENSHOT_FIXTURE_MODE',
      'EXPO_PUBLIC_SCREENSHOT_READY_URL',
      'EXPO_PUBLIC_SCREENSHOT_WORKOUT',
    ])
      delete metroEnv[key];
    const metroFd = openSync(metroLog, 'w');
    metro = spawn('vp', ['exec', 'expo', 'start', '--port', String(metroPort)], {
      cwd: join(ROOT, 'packages/mobile'),
      env: metroEnv,
      detached: true,
      stdio: ['ignore', metroFd, metroFd],
    });
    closeSync(metroFd);
    await waitFor(
      async () => {
        if (metro?.exitCode !== null) throw new Error('Tutorial Metro exited; see metro.log');
        try {
          return (await fetch(`http://127.0.0.1:${metroPort}/status`, { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          return false;
        }
      },
      120_000,
      'Metro',
    );
    const manifestResponse = await fetch(`http://127.0.0.1:${metroPort}/`, {
      headers: { 'expo-platform': 'android', accept: 'application/expo+json' },
      signal: AbortSignal.timeout(60_000),
    });
    const bundleUrl = ((await manifestResponse.json()) as { launchAsset?: { url?: string } }).launchAsset?.url;
    if (!bundleUrl) throw new Error('Metro manifest has no Android launch asset.');
    const bundle = await fetch(bundleUrl, { signal: AbortSignal.timeout(300_000) });
    await bundle.arrayBuffer();
    if (!bundle.ok) throw new Error(`Android bundle failed: HTTP ${bundle.status}`);
    const primaryAuth = await fetch(new URL('/auth/native/credentials', backend), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: env.TUTORIAL_DEMO_EMAIL ?? 'test@boardsesh.com',
        password: env.TUTORIAL_DEMO_PASSWORD ?? 'test',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    primaryJwt = ((await primaryAuth.json()) as { jwt?: string }).jwt;
    if (!primaryAuth.ok || !primaryJwt)
      throw new Error('Could not authenticate primary demo account for evidence checks.');
    const flow = async (path: string, label: string) => {
      const child = spawn(
        'maestro',
        [
          '--device',
          serial,
          'test',
          '--debug-output',
          join(work, 'maestro', label),
          '-e',
          `TUTORIAL_SIGNAL_URL=${signalUrl}`,
          '-e',
          `SHOWCASE_SIGNAL_URL=${signalUrl}`,
          resolve(ROOT, path),
        ],
        { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const timer = setTimeout(() => void stop(child), 150_000);
      try {
        await new Promise<void>((done, reject) => {
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0
              ? done()
              : reject(new Error(`Maestro ${label} failed (${code}); see ${join(work, 'maestro', label)}`)),
          );
        });
      } finally {
        clearTimeout(timer);
        writeFileSync(join(work, `${label}.log`), output);
      }
    };
    sessionTeardown = async () => {
      await flow('packages/mobile/.maestro/showcase/android/session-end.yaml', 'abort-session-end');
      activeSession = false;
    };
    for (const take of selectedTakes) {
      const takeDir = join(work, 'takes', take.id);
      const scenarioPath = env.TUTORIAL_SEED_FILE ?? join(options.workRoot, 'demo', 'seed.json');
      const fingerprint = tutorialCaptureFingerprint(
        take,
        {
          captureSourceSha256,
          nativeArtifactSha256,
          geometry,
          scenario: existsSync(scenarioPath)
            ? readFileSync(scenarioPath, 'utf8')
            : (env.TUTORIAL_SCENARIO_REVISION ?? '1'),
        },
        (path) => readFileSync(resolve(ROOT, path), 'utf8'),
      );
      const cachedPath = join(takeDir, 'manifest.json');
      if (!options.recapture && existsSync(cachedPath)) {
        try {
          const cached = JSON.parse(readFileSync(cachedPath, 'utf8')) as TutorialTakeManifest;
          if (
            tutorialManifestProblems(cached, take, fingerprint).length === 0 &&
            existsSync(join(takeDir, 'raw.mp4')) &&
            readdirSync(join(takeDir, 'frames')).filter((name) => /^\d{6}\.jpg$/.test(name)).length ===
              cached.frameCount
          ) {
            console.log(`[tutorial] Reusing ${take.id}`);
            continue;
          }
        } catch {
          /* incomplete cache is recorded again */
        }
      }
      rmSync(takeDir, { recursive: true, force: true });
      mkdirSync(join(takeDir, 'frames'), { recursive: true });
      const baseline = readFileSync(metroLog, 'utf8').length;
      command(adb, ['-s', serial, 'shell', 'am', 'force-stop', APP], env);
      command(
        adb,
        [
          '-s',
          serial,
          'shell',
          'am',
          'start',
          '-a',
          'android.intent.action.VIEW',
          '-d',
          androidDevClientUrl(metroPort),
        ],
        env,
      );
      await waitFor(
        () => readFileSync(metroLog, 'utf8').slice(baseline).includes('$screen /home'),
        120_000,
        'signed-in app home',
      );
      command(
        adb,
        [
          '-s',
          serial,
          'shell',
          'am',
          'start',
          '-a',
          'android.intent.action.VIEW',
          '-d',
          `'${`com.boardsesh.app://${take.route}`.replaceAll("'", "'\\''")}'`,
        ],
        env,
      );
      await sleep(2500);
      for (const setup of take.setupFlows ?? []) await flow(setup, `${take.id}-setup`);
      if (take.requiresDownload)
        await flow('packages/mobile/.maestro/tutorial/download-ready.yaml', `${take.id}-download-ready`);
      if (take.session === 'crew') {
        activeSession = true;
        await flow('packages/mobile/.maestro/tutorial/crew-setup.yaml', 'crew-session');
        const beforeRelaunch = readFileSync(metroLog, 'utf8').length;
        command(adb, ['-s', serial, 'shell', 'am', 'force-stop', APP], env);
        command(
          adb,
          [
            '-s',
            serial,
            'shell',
            'am',
            'start',
            '-a',
            'android.intent.action.VIEW',
            '-d',
            androidDevClientUrl(metroPort),
          ],
          env,
        );
        let sessionId = '';
        await waitFor(
          () => {
            const restored = /\[session\] restored from store:\s*([a-f0-9-]{36})/.exec(
              readFileSync(metroLog, 'utf8').slice(beforeRelaunch),
            );
            sessionId = restored?.[1] ?? '';
            return !!sessionId;
          },
          120_000,
          'new crew session identity',
        );
        const signIn = await fetch(new URL('/auth/native/credentials', backend), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: env.TUTORIAL_CREW_EMAIL, password: env.TUTORIAL_CREW_PASSWORD }),
          signal: AbortSignal.timeout(15_000),
        });
        const jwt = ((await signIn.json()) as { jwt?: string }).jwt;
        if (!signIn.ok || !jwt) throw new Error('Local crew account could not authenticate.');
        crew = new CrewParticipant(backend, jwt);
        const joined = (await crew.execute(JOIN_SESSION, {
          sessionId,
          boardPath: env.TUTORIAL_BOARD_PATH ?? 'kilter/1/7/1',
          username: 'Sam',
        })) as {
          joinSession: {
            clientId: string;
            users: { userId: string; username: string; avatarUrl: string | null }[];
            queueState: {
              queue: { climb: Record<string, unknown> }[];
              currentClimbQueueItem?: { climb: Record<string, unknown> };
            };
          };
        };
        const seed = existsSync(scenarioPath)
          ? (JSON.parse(readFileSync(scenarioPath, 'utf8')) as { crewClimbs?: Record<string, unknown>[] })
          : undefined;
        const queuedIds = new Set([
          ...joined.joinSession.queueState.queue.map((item) => item.climb.uuid),
          joined.joinSession.queueState.currentClimbQueueItem?.climb.uuid,
        ]);
        const climb = seed?.crewClimbs?.find((candidate) => !queuedIds.has(candidate.uuid));
        if (!climb) throw new Error('Crew seed has no distinct real climb to contribute.');
        const profile = joined.joinSession.users.find((user) => user.username === 'Sam');
        if (!profile?.userId) throw new Error('Joined crew socket has no authenticated Sam profile.');
        crewAdd = async () => {
          await crew!.execute(ADD_QUEUE_ITEM, {
            item: {
              uuid: randomUUID(),
              climb,
              addedBy: joined.joinSession.clientId,
              addedByUser: { id: profile.userId, username: 'Sam', avatarUrl: profile.avatarUrl },
            },
          });
        };
        await flow('packages/mobile/.maestro/showcase/android/crew-invite.yaml', 'crew-invite');
      }
      marks.clear();
      signals.clear();
      signalFailure = undefined;
      timerSessionId = undefined;
      timerCurrentUuid = undefined;
      const anchors: Record<string, TutorialAnchor[]> = {};
      let logOffset = readFileSync(metroLog, 'utf8').length;
      const remote = `/sdcard/tutorial-${take.id}-${Date.now()}.mp4`;
      const started = Date.now();
      const recorder = spawn(adb, buildScreenrecordArgs(serial, remote, 170), {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let recordingReady = false;
      let recorderError: Error | undefined;
      recorder.on('error', (error) => {
        recorderError = error;
      });
      for (const stream of [recorder.stdout, recorder.stderr])
        stream?.on('data', (chunk: Buffer) => {
          if (isScreenrecordStartedLine(chunk.toString())) recordingReady = true;
        });
      let recordStart = started;
      // Layout anchors already emitted while preparing the screen remain valid
      // at time zero until a fresh sample replaces them.
      for (const line of readFileSync(metroLog, 'utf8').slice(baseline).split('\n')) {
        const anchor = parseShowcaseAnchorLine(line);
        if (anchor)
          anchors[anchor.name] = [{ t: 0, x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }];
      }
      const poll = setInterval(() => {
        const text = readFileSync(metroLog, 'utf8');
        const fresh = text.slice(logOffset);
        logOffset = text.length;
        for (const line of fresh.split('\n')) {
          const anchor = parseShowcaseAnchorLine(line);
          if (anchor)
            (anchors[anchor.name] ??= []).push({
              t: (Date.now() - recordStart) / 1000,
              x: anchor.x,
              y: anchor.y,
              width: anchor.width,
              height: anchor.height,
            });
        }
      }, 100);
      try {
        await waitFor(
          () => {
            if (recorderError) throw recorderError;
            if (recorder.exitCode !== null) throw new Error('screenrecord exited before capture');
            return recordingReady;
          },
          10_000,
          'screenrecord encoder',
        );
        recordStart = Date.now();
        if (take.session) activeSession = true;
        await flow(take.flow, take.id);
        if (signalFailure) throw signalFailure;
        const minimumEnd = (marks.get('flow-start') ?? recordStart) + take.minSeconds * 1000 + 200;
        if (Date.now() < minimumEnd) await sleep(minimumEnd - Date.now());
      } finally {
        clearInterval(poll);
        // SIGINT must reach the encoder in the guest so MP4 gets its moov atom.
        try {
          const pid = command(adb, ['-s', serial, 'shell', 'pidof', 'screenrecord'], env, 5000).trim();
          if (pid && /^\d+(?: \d+)*$/.test(pid))
            command(adb, ['-s', serial, 'shell', 'kill', '-2', ...pid.split(' ')], env, 5000);
        } catch {
          /* already ended */
        }
        if (recorder.exitCode === null && recorder.signalCode === null)
          await Promise.race([new Promise<void>((done) => recorder.once('exit', () => done())), sleep(8000)]);
        if (recorder.exitCode === null && recorder.signalCode === null) {
          recorder.kill('SIGKILL');
          recorderError = new Error('screenrecord did not finalize after SIGINT');
        }
      }
      if (recorderError) throw recorderError;
      const ended = Date.now();
      command(adb, ['-s', serial, 'pull', remote, join(takeDir, 'raw.mp4')], env);
      command(adb, ['-s', serial, 'shell', 'rm', remote], env);
      const trim = ((marks.get('flow-start') ?? recordStart) - started) / 1000;
      const rawSeconds = Number(
        command(
          env.FFPROBE_BIN ?? 'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            join(takeDir, 'raw.mp4'),
          ],
          env,
        ),
      );
      if (!Number.isFinite(rawSeconds) || rawSeconds <= trim)
        throw new Error(`Capture ${take.id} has invalid or truncated raw recording.`);
      const seconds = Math.min(rawSeconds - trim, (ended - (marks.get('flow-start') ?? recordStart)) / 1000);
      command(
        env.FFMPEG_BIN ?? 'ffmpeg',
        [
          '-y',
          '-loglevel',
          'error',
          '-i',
          join(takeDir, 'raw.mp4'),
          '-an',
          '-vf',
          `fps=30,trim=start=${trim.toFixed(3)}:duration=${seconds.toFixed(3)},setpts=PTS-STARTPTS,format=yuvj420p`,
          '-q:v',
          '3',
          '-start_number',
          '1',
          join(takeDir, 'frames', '%06d.jpg'),
        ],
        env,
        180_000,
      );
      const flowStart = marks.get('flow-start') ?? recordStart;
      const relativeMarks = Object.fromEntries(
        [...marks].map(([name, timestamp]) => [name, (timestamp - flowStart) / 1000]),
      );
      const anchorTrim = (flowStart - recordStart) / 1000;
      const relativeAnchors = Object.fromEntries(
        Object.entries(anchors).map(([name, samples]) => [
          name,
          trimTutorialAnchors(samples, anchorTrim, geometry.screen, seconds),
        ]),
      );
      const frameCount = readdirSync(join(takeDir, 'frames')).filter((name) => name.endsWith('.jpg')).length;
      const manifest: TutorialTakeManifest = {
        formatVersion: 1,
        takeId: take.id,
        platform: 'android',
        fps: 30,
        ...geometry,
        frameCount,
        seconds: frameCount / 30,
        sourceCommit,
        sourceDirty: tutorialModifiedSourcePaths(ROOT).length > 0,
        nativeArtifactSha256,
        fingerprint,
        marks: relativeMarks,
        anchors: relativeAnchors,
      };
      const problems = tutorialManifestProblems(manifest, take, fingerprint);
      if (problems.length) throw new Error(`Capture ${take.id} failed validation: ${problems.join('; ')}`);
      writeFileSync(`${cachedPath}.tmp`, JSON.stringify(manifest, null, 2));
      renameSync(`${cachedPath}.tmp`, cachedPath);
      crew?.close();
      crew = undefined;
      crewAdd = undefined;
      if (take.session) {
        await flow('packages/mobile/.maestro/showcase/android/session-end.yaml', `${take.id}-end`);
        activeSession = false;
      }
    }
  } finally {
    crew?.close();
    if (activeSession && sessionTeardown) {
      try {
        await sessionTeardown();
      } catch (error: unknown) {
        console.error(`[tutorial] Could not end demo session: ${String(error)}`);
      }
    }
    server.close();
    if (metro) await stop(metro);
    if (emulator) {
      try {
        command(adb, ['-s', serial, 'emu', 'kill'], env);
      } catch {
        /* crashed emulator */
      }
      await stop(emulator);
    }
  }
}
