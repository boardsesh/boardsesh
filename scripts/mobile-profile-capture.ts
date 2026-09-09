/// <reference types="node" />
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { captureMemory } from './lib/ios-memory-capture';
import {
  type MemorySurface,
  type MemoryWorkload,
  parseMemoryFlowTimeoutMs,
  validateMemoryMeasurements,
  validateOwnershipMeasurements,
} from './lib/ios-memory-profile';
import { hasUsefulStartupArtifact, assertMatchingIdentity, readAppIdentity } from './lib/ios-profile-identity';
import { guardSimulatorCommand, holdSimulatorLease } from './lib/ios-simulator-lease';

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('@expo/cli/package.json'));
// Expo already pins ws; its Origin option is required by Metro's inspector proxy.
const InspectorWebSocket = expoRequire('ws') as new (url: string, options: { origin: string }) => WebSocket;

interface CaptureOptions {
  runDir: string;
  udid: string;
  appId: string;
  configuration: 'Debug' | 'Release';
  port: number;
}
interface StartupArtifact {
  runId: string;
  marks: { name: string; timestampMs: number; outcome?: string }[];
}
export function distribution(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    samples,
    count: samples.length,
    min: sorted[0] ?? null,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  };
}
export function physicalFootprintMiB(report: string): number | null {
  const match = report.match(/^Physical footprint:\s+([\d.]+)([KMG])(?:B)?/m);
  if (!match) return null;
  return Number(match[1]) * (match[2] === 'G' ? 1024 : match[2] === 'K' ? 1 / 1024 : 1);
}
export function usefulStartup(artifact: unknown, previousRunId: string | null): artifact is StartupArtifact {
  return hasUsefulStartupArtifact(artifact) && (artifact as StartupArtifact).runId !== previousRunId;
}
export function readRenderKeys(container: string) {
  const directory = join(container, 'Library', 'Caches', 'board-thumbnails');
  const renderKeys = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => /^v\d+_.*\.png$/.test(name))
        .sort()
    : [];
  return {
    renderKeys,
    renderedClimbSignatures: [...new Set(renderKeys.map((key) => key.split('_').at(-1) ?? ''))].sort((left, right) =>
      left.localeCompare(right),
    ),
    meaning:
      'Completed on-disk overlay cache keys, with distinct frame/color signatures; these are not retained-object or UUID counts.',
  };
}

const pause = (milliseconds: number) => new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds));
function save(directory: string, name: string, artifact: unknown) {
  writeFileSync(join(directory, name), JSON.stringify(artifact, null, 2));
}
function simctl(options: CaptureOptions, args: string[]): string {
  guardSimulatorCommand('xcrun', ['simctl', ...args], process.cwd());
  return execFileSync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function previousStartupRunId(options: CaptureOptions): string | null {
  try {
    const container = simctl(options, ['get_app_container', options.udid, options.appId, 'data']);
    const artifact = JSON.parse(
      readFileSync(join(container, 'Documents', 'boardsesh-profile', 'startup-latest.json'), 'utf8'),
    ) as Partial<StartupArtifact>;
    return typeof artifact.runId === 'string' ? artifact.runId : null;
  } catch {
    return null;
  }
}
function launch(options: CaptureOptions): number {
  const output = simctl(options, ['launch', options.udid, options.appId]);
  const pid = Number(output.match(/:\s*(\d+)\s*$/)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Could not identify launched app PID: ${output}`);
  return pid;
}
function terminate(options: CaptureOptions) {
  try {
    simctl(options, ['terminate', options.udid, options.appId]);
  } catch (error) {
    if (!String(error).includes('not running') && !String(error).includes('found nothing to terminate')) throw error;
  }
}
function navigate(options: CaptureOptions, route: string) {
  const assertion =
    route === 'home' || route === 'climbs'
      ? `    id: ${route}-screen`
      : `    text: '${route === 'discover' ? 'My Playlists' : 'Progress'}'`;
  const flowPath = join(options.runDir, `navigate-${route}.yaml`);
  writeFileSync(
    flowPath,
    `appId: ${options.appId}\n---\n- openLink: com.boardsesh.app://${route}\n- tapOn:\n    text: Open\n    optional: true\n- waitForAnimationToEnd\n- extendedWaitUntil:\n    visible:\n  ${assertion}\n    timeout: 15000\n`,
  );
  const args = ['--device', options.udid, 'test', flowPath];
  guardSimulatorCommand('maestro', args, process.cwd());
  const navigation = spawnSync('maestro', args, { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(
    join(options.runDir, `navigate-${route}.log`),
    Buffer.concat([navigation.stdout ?? Buffer.alloc(0), navigation.stderr ?? Buffer.alloc(0)]),
  );
  if (navigation.status !== 0) throw new Error(`Navigation to ${route} was not confirmed; capture is incomplete.`);
}

function screenshot(options: CaptureOptions, name: string) {
  simctl(options, ['io', options.udid, 'screenshot', join(options.runDir, name)]);
}
async function waitForStartup(options: CaptureOptions, previousRunId: string | null) {
  const container = simctl(options, ['get_app_container', options.udid, options.appId, 'data']);
  const path = join(container, 'Documents', 'boardsesh-profile', 'startup-latest.json');
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    try {
      const artifact: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (usefulStartup(artifact, previousRunId)) return artifact;
    } catch {
      /* File may not exist yet, or writer may be replacing it. */
    }
    await pause(100);
  }
  throw new Error('No fresh useful Home commit artifact within 45 seconds.');
}

export interface DebuggerTarget {
  appId: string;
  webSocketDebuggerUrl: string;
}
export function selectDebuggerTarget(candidates: unknown, appId: string): DebuggerTarget | undefined {
  if (!Array.isArray(candidates)) throw new Error('Invalid Metro debugger target list.');
  const matching = candidates.filter(
    (target): target is DebuggerTarget =>
      target !== null &&
      typeof target === 'object' &&
      target.appId === appId &&
      typeof target.webSocketDebuggerUrl === 'string',
  );
  if (matching.length > 1) throw new Error(`Multiple runtimes for ${appId}; refusing an ambiguous capture.`);
  return matching[0];
}

class CdpProtocolError extends Error {}

export class CdpClient {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(result: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  readonly events: { method: string; params?: Record<string, unknown> }[] = [];
  constructor(private socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (response.id !== undefined) {
        const request = this.pending.get(response.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(response.id);
        if (response.error) request.reject(new CdpProtocolError(JSON.stringify(response.error)));
        else request.resolve(response.result);
      } else if (response.method && this.events.length < 100_000)
        this.events.push({ method: response.method, params: response.params });
    });
  }
  static async connect(port: number, appId = 'com.boardsesh.app') {
    let runtime: DebuggerTarget | undefined;
    const deadline = Date.now() + 10000;
    while (!runtime && Date.now() < deadline) {
      const targets: unknown = await (
        await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
      ).json();
      runtime = selectDebuggerTarget(targets, appId);
      if (!runtime) await pause(250);
    }
    if (!runtime) throw new Error(`No registered debugger runtime for ${appId}.`);
    const socketUrl = new URL(runtime.webSocketDebuggerUrl);
    if (!['localhost', '127.0.0.1'].includes(socketUrl.hostname) || Number(socketUrl.port) !== port)
      throw new Error('Debugger target points outside the selected local Metro.');
    const socket = new InspectorWebSocket(runtime.webSocketDebuggerUrl, { origin: `http://localhost:${port}` });
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout.')), 5000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP connection failed.'));
        },
        { once: true },
      );
    });
    return new CdpClient(socket);
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, 10_000);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string): Promise<unknown> {
    const response = (await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    };
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  }
  close() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP closed.'));
    }
    this.pending.clear();
    this.socket.close();
  }
}

async function initializeDebugNavigation(cdp: CdpClient) {
  const ready = await cdp.evaluate(`(() => {
    for (const definition of __r.getModules().values()) {
      if (!definition.isInitialized) continue;
      const exported = definition.publicModule?.exports;
      if (!exported || typeof exported !== 'object') continue;
      if (typeof exported.router?.navigate === 'function') globalThis.__boardseshCaptureRouter = exported.router;
      if (typeof exported.store?.getRouteInfo === 'function') globalThis.__boardseshCaptureRouterStore = exported.store;
    }
    return !!globalThis.__boardseshCaptureRouter && !!globalThis.__boardseshCaptureRouterStore;
  })()`);
  if (!ready) throw new Error('Initialized Expo Router navigation/state APIs unavailable.');
}
async function navigateDebug(cdp: CdpClient, route: string, settleMs: number) {
  await cdp.evaluate(`__boardseshCaptureRouter.navigate(${JSON.stringify('/' + route)}); true`);
  await pause(settleMs);
  const pathname = await cdp.evaluate('__boardseshCaptureRouterStore.getRouteInfo().pathname');
  if (pathname !== '/' + route)
    throw new Error(`Expected /${route}, observed ${String(pathname)}; navigation capture invalid.`);
}

async function captureDebug(options: CaptureOptions) {
  const previousRunId = previousStartupRunId(options);
  terminate(options);
  const pid = launch(options);
  await waitForStartup(options, previousRunId);
  const cdp = await CdpClient.connect(options.port, options.appId);
  const capability: Record<string, unknown> = {};
  const navigation: unknown[] = [];
  let tracingStarted = false;
  try {
    // A capability probe in a fresh process; an incomplete trace is never a pass.
    try {
      await cdp.call('Tracing.start');
      tracingStarted = true;
      await pause(250);
      await cdp.call('Tracing.end');
      const deadline = Date.now() + 10_000;
      while (!cdp.events.some((event) => event.method === 'Tracing.tracingComplete') && Date.now() < deadline)
        await pause(50);
      const complete = cdp.events.some((event) => event.method === 'Tracing.tracingComplete');
      const chunks = cdp.events.filter((event) => event.method === 'Tracing.dataCollected');
      capability.tracing = { complete, chunks: chunks.length };
      save(options.runDir, 'tracing-probe.json', cdp.events);
      if (!complete) throw new Error('Tracing did not finish; refusing measurements with uncertain tracing overhead.');
      tracingStarted = false;
    } catch (error) {
      capability.tracing = { complete: false, reason: String(error) };
      if (tracingStarted || !(error instanceof CdpProtocolError)) {
        await cdp.call('Tracing.end').catch(() => undefined);
        throw error;
      }
    }
    await initializeDebugNavigation(cdp);
    const routes = ['home', 'climbs', 'discover', 'profile'];
    for (let loop = 0; loop < 2; loop++)
      for (const route of routes) {
        await navigateDebug(cdp, route, 2000);
      }
    const rendererId = await cdp.evaluate(
      `(() => { const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__; return hook?.rendererInterfaces ? [...hook.rendererInterfaces.keys()].find(id => hook.rendererInterfaces.get(id).startProfiling) ?? null : null; })()`,
    );
    capability.react = { available: typeof rendererId === 'number', complete: false };
    if (typeof rendererId === 'number')
      await cdp.evaluate(
        `__REACT_DEVTOOLS_GLOBAL_HOOK__.rendererInterfaces.get(${rendererId}).startProfiling(true); true`,
      );
    for (let loop = 1; loop <= 5; loop++) {
      for (const route of routes) {
        await cdp.evaluate(
          `(() => { globalThis.__boardseshCapture = { gaps: [], longTasks: [], previous: performance.now() }; const state = __boardseshCapture; state.observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) if(state.longTasks.length < 1000) state.longTasks.push(entry.duration); }); state.observer.observe({entryTypes:['longtask']}); const frame = () => { const now = performance.now(); if(state.gaps.length < 2000) state.gaps.push(now-state.previous); state.previous=now; state.frame=requestAnimationFrame(frame); }; state.frame=requestAnimationFrame(frame); return true; })()`,
        );
        const sampleStartedAt = performance.now();
        let sampleCompleted: Promise<boolean> | undefined;
        if (typeof rendererId !== 'number') {
          const nativeSample = spawn(
            'sample',
            [String(pid), '5', '-file', join(options.runDir, `navigation-${loop}-${route}.sample.txt`)],
            { stdio: 'ignore' },
          );
          sampleCompleted = new Promise<boolean>((resolveSample) => {
            nativeSample.once('error', () => resolveSample(false));
            nativeSample.once('exit', (status) => resolveSample(status === 0));
          });
        }
        await navigateDebug(cdp, route, 4000);
        const navigationConfirmedAt = performance.now();
        const nativeSampleComplete = sampleCompleted
          ? (await sampleCompleted) && navigationConfirmedAt - sampleStartedAt <= 5000
          : false;
        const observation = await cdp.evaluate(
          `(() => { const state=__boardseshCapture; cancelAnimationFrame(state.frame); state.observer.disconnect(); return { gaps:state.gaps, longTasks:state.longTasks }; })()`,
        );
        navigation.push({
          loop,
          route,
          routeConfirmed: true,
          nativeSampleComplete,
          sampleStartedAt,
          navigationConfirmedAt,
          observation,
        });
        save(options.runDir, 'navigation.json', navigation);
        screenshot(options, `navigation-${loop}-${route}.png`);
        console.log(`[mobile:profile] Debug loop ${loop}/5 ${route}`);
      }
    }
    if (typeof rendererId === 'number') {
      await cdp.evaluate(`__REACT_DEVTOOLS_GLOBAL_HOOK__.rendererInterfaces.get(${rendererId}).stopProfiling(); true`);
      const profile = await cdp.evaluate(
        `__REACT_DEVTOOLS_GLOBAL_HOOK__.rendererInterfaces.get(${rendererId}).getProfilingData()`,
      );
      save(options.runDir, 'react-profile.json', profile);
      const reactProfile = profile as { dataForRoots?: { commitData?: unknown[] }[] };
      const complete = reactProfile.dataForRoots?.some((root) => (root.commitData?.length ?? 0) > 0) ?? false;
      capability.react = { available: true, complete };
      if (!complete) throw new Error('React profiling returned no commits.');
      const names = await cdp.evaluate(
        `(() => { const renderer=__REACT_DEVTOOLS_GLOBAL_HOOK__.rendererInterfaces.get(${rendererId}); const profile=renderer.getProfilingData(); const ids=new Set(profile.dataForRoots.flatMap(root=>root.commitData.flatMap(commit=>commit.fiberActualDurations.map(pair=>pair[0])))); return [...ids].map(id=>[id,renderer.getDisplayNameForElementID(id)]); })()`,
      );
      save(options.runDir, 'react-names.json', names);
    }
    const samplePath = join(options.runDir, 'debug-native.sample.txt');
    const sample = spawnSync('sample', [String(pid), '1', '-file', samplePath], { timeout: 15_000, stdio: 'pipe' });
    const nativeSampleComplete =
      sample.status === 0 && existsSync(samplePath) && readFileSync(samplePath, 'utf8').includes('Call graph:');
    capability.nativeSample = { complete: nativeSampleComplete };
    if (
      typeof rendererId !== 'number' &&
      !navigation.every((entry) => (entry as { nativeSampleComplete: boolean }).nativeSampleComplete)
    )
      throw new Error('Neither React attribution nor complete in-scenario native samples are available.');
    return {
      configuration: 'Debug',
      warmupLoops: 2,
      measuredLoops: 5,
      navigation,
      capability,
      timingMeaning: 'JS callback gaps and React render durations, not native FPS.',
    };
  } finally {
    try {
      await cdp.evaluate(
        `(() => { const state=globalThis.__boardseshCapture; if(state) { cancelAnimationFrame(state.frame); state.observer?.disconnect(); } for(const renderer of globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__?.rendererInterfaces?.values() ?? []) renderer.stopProfiling?.(); delete globalThis.__boardseshCapture; return true; })()`,
      );
    } catch {
      /* The owned runtime may have exited; never hide the capture failure. */
    }
    cdp.close();
  }
}

async function captureRelease(options: CaptureOptions) {
  const launches: unknown[] = [];
  let previousRunId: string | null = null;
  // First fixture login/cache population is excluded from the ten warm-cache launches.
  previousRunId = previousStartupRunId(options);
  terminate(options);
  launch(options);
  const warmup = await waitForStartup(options, previousRunId);
  previousRunId = warmup.runId;
  navigate(options, 'home');
  await pause(3000);
  const hostExportObservedMs: number[] = [];
  for (let trial = 1; trial <= 10; trial++) {
    terminate(options);
    await pause(500);
    const hostStart = performance.now();
    const pid = launch(options);
    const artifact = await waitForStartup(options, previousRunId);
    const observedMs = performance.now() - hostStart;
    hostExportObservedMs.push(observedMs);
    previousRunId = artifact.runId;
    save(options.runDir, `startup-${trial}.json`, artifact);
    screenshot(options, `launch-${trial}.png`);
    launches.push({ trial, pid, hostExportObservedMs: observedMs, artifact });
    save(options.runDir, 'launches.json', launches);
    console.log(
      `[mobile:profile] Release launch ${trial}/10: local useful-commit export observed ${Math.round(observedMs)} ms`,
    );
    await pause(2000);
  }
  const pid = launch(options);
  const memory: {
    cycle: number;
    pid: number;
    footprintMiB: number | null;
    renderKeys: ReturnType<typeof readRenderKeys>;
  }[] = [];
  const appContainer = simctl(options, ['get_app_container', options.udid, options.appId, 'data']);
  const initialRenderKeys = readRenderKeys(appContainer);
  const flowPath = join(options.runDir, 'browse-cycle.yaml');
  writeFileSync(
    flowPath,
    `appId: ${options.appId}\n---\n- repeat:\n    times: 3\n    commands:\n      - swipe:\n          start: 50%,75%\n          end: 50%,30%\n          duration: 400\n- waitForAnimationToEnd\n`,
  );
  for (let cycle = 1; cycle <= 20; cycle++) {
    navigate(options, 'climbs');
    await pause(1000);
    const args = ['--device', options.udid, 'test', flowPath];
    guardSimulatorCommand('maestro', args, process.cwd());
    const browsing = spawnSync('maestro', args, { timeout: 60_000, stdio: 'pipe' });
    writeFileSync(
      join(options.runDir, `browse-${cycle}.log`),
      Buffer.concat([browsing.stdout ?? Buffer.alloc(0), browsing.stderr ?? Buffer.alloc(0)]),
    );
    if (browsing.status !== 0) throw new Error(`Browsing cycle ${cycle} failed; incomplete memory run.`);
    simctl(options, ['launch', options.udid, 'com.apple.Preferences']);
    await pause(2000);
    if (launch(options) !== pid) throw new Error('Memory run app process changed; samples cannot be compared.');
    navigate(options, 'home');
    await pause(3000);
    const samplePath = join(options.runDir, `memory-${cycle}.sample.txt`);
    const sampled = spawnSync('sample', [String(pid), '1', '-file', samplePath], { timeout: 15_000, stdio: 'pipe' });
    if (sampled.status !== 0 || !existsSync(samplePath)) throw new Error(`Native memory sample ${cycle} failed.`);
    const footprintMiB = physicalFootprintMiB(readFileSync(samplePath, 'utf8'));
    if (footprintMiB === null || !Number.isFinite(footprintMiB))
      throw new Error(`Physical footprint missing in sample ${cycle}.`);
    memory.push({ cycle, pid, footprintMiB, renderKeys: readRenderKeys(appContainer) });
    save(options.runDir, 'memory.json', memory);
    console.log(`[mobile:profile] Release memory cycle ${cycle}/20: ${memory.at(-1)?.footprintMiB} MiB`);
  }
  return {
    configuration: 'Release',
    initialRenderKeys,
    launches,
    memory,
    hostExportObservedMs: distribution(hostExportObservedMs),
    hostTimingMeaning:
      'Host launch to local useful-commit artifact observation; includes deferred export and polling, not first displayed frame.',
    memoryMeaning:
      'Same-process physical footprint at settled Home after browsing/background; allocation attribution and distinct render-key counts require separate capture.',
  };
}

export async function main(argv = process.argv.slice(2)) {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) flags.set(argv[index], argv[index + 1]);
  if (flags.has('--memory-flow-timeout-ms') && flags.get('--memory-flow-timeout-ms') === undefined)
    throw new Error('--memory-flow-timeout-ms requires a value.');
  const memoryFlowTimeoutMs = parseMemoryFlowTimeoutMs(flags.get('--memory-flow-timeout-ms'));
  const options: CaptureOptions = {
    runDir: resolve(flags.get('--run-dir') ?? '.boardsesh/ios-profile-capture'),
    udid: flags.get('--udid') ?? '',
    appId: flags.get('--app-id') ?? 'com.boardsesh.app',
    configuration: flags.get('--configuration') === 'Debug' ? 'Debug' : 'Release',
    port: Number(flags.get('--port') ?? '8097'),
  };
  if (
    flags.get('--scenario') === 'memory' &&
    [
      'measurements.json',
      'ownership-measurements.json',
      'capture-validity.json',
      'memory-samples.json',
      'memory-manifest.json',
      'ownership',
    ].some((filename) => existsSync(join(options.runDir, filename)))
  )
    throw new Error('Memory capture directory already contains evidence; use a fresh run directory.');
  mkdirSync(options.runDir, { recursive: true });
  holdSimulatorLease(options.udid, process.cwd());
  try {
    const scenario = flags.get('--scenario') ?? 'default';
    if (!['default', 'memory'].includes(scenario)) throw new Error('Invalid capture scenario.');
    const surface = flags.get('--surface') ?? 'list';
    const workload = flags.get('--workload') ?? 'replay';
    const inspection = flags.get('--inspection') ?? 'none';
    const inspectionOnlyFlag = flags.get('--inspection-only') ?? 'false';
    if (!['true', 'false'].includes(inspectionOnlyFlag)) throw new Error('--inspection-only requires true or false.');
    const inspectionOnly = inspectionOnlyFlag === 'true';
    if (inspectionOnly && scenario !== 'memory') throw new Error('Ownership-only capture requires --scenario memory.');
    if (
      !['list', 'carousel'].includes(surface) ||
      !['replay', 'expanding', 'idle'].includes(workload) ||
      !['none', 'ownership', 'graphs'].includes(inspection)
    )
      throw new Error('Invalid memory capture options.');
    const expectedIdentity = flags.get('--app-path')
      ? readAppIdentity(flags.get('--app-path')!, options.configuration)
      : null;
    if (scenario === 'memory' && !expectedIdentity)
      throw new Error('Memory capture requires --app-path for installed executable verification.');
    const verifyInstalled = () => {
      if (expectedIdentity)
        assertMatchingIdentity(
          expectedIdentity,
          readAppIdentity(
            simctl(options, ['get_app_container', options.udid, options.appId, 'app']),
            options.configuration,
          ),
        );
    };
    verifyInstalled();
    let previousRunId = previousStartupRunId(options);
    const measurements =
      scenario === 'memory'
        ? await captureMemory(
            {
              ...options,
              surface: surface as MemorySurface,
              workload: workload as MemoryWorkload,
              inspection: inspection as 'none' | 'ownership' | 'graphs',
              inspectionOnly,
              failedAllocationProbe: flags.get('--failed-allocation-probe') ?? null,
              memoryFlowTimeoutMs,
              memoryManifest: resolve(flags.get('--memory-manifest') ?? '.boardsesh/ios-memory-climbs.json'),
              compareCache: flags.get('--compare-cache') ?? null,
              idleSchedule: flags.get('--idle-schedule') ?? null,
            },
            {
              simctl: (args) => simctl(options, args),
              launch: () => launch(options),
              terminate: () => terminate(options),
              navigate: (route) => navigate(options, route),
              footprint: physicalFootprintMiB,
              startup: async () => {
                const artifact = await waitForStartup(options, previousRunId);
                previousRunId = artifact.runId;
                return artifact;
              },
            },
          )
        : options.configuration === 'Debug'
          ? await captureDebug(options)
          : await captureRelease(options);
    verifyInstalled();
    if (inspectionOnly) validateOwnershipMeasurements(measurements);
    else if (scenario === 'memory') validateMemoryMeasurements(measurements);
    save(options.runDir, inspectionOnly ? 'ownership-measurements.json' : 'measurements.json', measurements);
    save(options.runDir, 'capture-validity.json', {
      valid: true,
      completed: true,
      configuration: options.configuration,
      scenario: inspectionOnly ? 'ownership' : scenario,
      limitations:
        scenario === 'memory'
          ? [
              'Simulator only; physical-device conclusions remain pending.',
              'Surviving-object reference inspection is supplemental and does not establish a leak automatically.',
            ]
          : [
              'Simulator only; device validation required.',
              'No native FPS claim.',
              'Pending supplemental captures: allocation inspection, exact distinct climb IDs, and 20/100/200 shelf populations.',
            ],
    });
    return 0;
  } catch (error) {
    save(options.runDir, 'capture-validity.json', {
      valid: false,
      completed: false,
      scenario: flags.get('--inspection-only') === 'true' ? 'ownership' : (flags.get('--scenario') ?? 'default'),
      error: String(error),
    });
    console.error(error);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().then((status) => {
    process.exitCode = status;
  });
