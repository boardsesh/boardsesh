import { createStartupCollector, type StartupMarkName, type StartupOutcome } from './startup-collector';

export const STARTUP_PROFILING_ENABLED = process.env.EXPO_PUBLIC_PROFILE_STARTUP === '1';
const collector = createStartupCollector(STARTUP_PROFILING_ENABLED, () => performance.now());
const runId = STARTUP_PROFILING_ENABLED ? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` : '';
let exportTimer: ReturnType<typeof setTimeout> | undefined;
let exportInFlight: Promise<void> | undefined;
let exportedRevision = -1;

const RN_TIMING_KEYS = [
  'startTime',
  'initializeRuntimeStart',
  'executeJavaScriptBundleEntryPointStart',
  'endTime',
] as const;

function snapshot() {
  const runtimePerformance = performance as typeof performance & {
    rnStartupTiming?: Partial<Record<(typeof RN_TIMING_KEYS)[number], number | null>>;
  };
  // Copy explicit getters: RN's platform object has no enumerable own fields.
  const rnStartupTiming = Object.fromEntries(
    RN_TIMING_KEYS.map((key) => {
      const timestamp = runtimePerformance.rnStartupTiming?.[key];
      return [key, typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : null];
    }),
  );
  return {
    schemaVersion: 1,
    runId,
    jsClock: 'RN performance.now monotonic milliseconds; compare differences within one run only',
    nativeClock: 'RN startup timing milliseconds; RN time origin; unavailable fields are null',
    hostClock: 'not collected; do not subtract host launch timestamps from these marks',
    rnStartupTiming,
    marks: collector.snapshot(),
  };
}

async function flush(): Promise<void> {
  if (!STARTUP_PROFILING_ENABLED) return;
  if (exportInFlight) {
    await exportInFlight;
    return flush();
  }
  const captured = snapshot();
  if (exportedRevision === captured.marks.length) return;
  exportInFlight = (async () => {
    const { Directory, File, Paths } = await import('expo-file-system');
    const directory = new Directory(Paths.document, 'boardsesh-profile');
    directory.create({ intermediates: true, idempotent: true });
    // A fixed file bounds disk usage across process-cold launches. The runner
    // copies it after each launch and rejects a stale runId from a previous run.
    new File(directory, 'startup-latest.json').write(JSON.stringify(captured, null, 2));
    exportedRevision = captured.marks.length;
  })();
  try {
    await exportInFlight;
  } finally {
    exportInFlight = undefined;
  }
}

function scheduleExport(delayMs: number) {
  if (exportTimer) clearTimeout(exportTimer);
  exportTimer = setTimeout(() => {
    exportTimer = undefined;
    // Local diagnostics must never change startup behavior if disk export fails.
    void flush().catch(() => {});
  }, delayMs);
}

export function markStartup(name: StartupMarkName, outcome?: StartupOutcome): void {
  if (!collector.mark(name, outcome)) return;
  if (name === 'home.useful.commit' || name === 'sqlite.recovery.end') scheduleExport(1_000);
}

if (STARTUP_PROFILING_ENABLED) {
  const profilingGlobal = globalThis as typeof globalThis & {
    __boardseshStartupProfile?: { snapshot: typeof snapshot; flush: typeof flush };
  };
  profilingGlobal.__boardseshStartupProfile = { snapshot, flush };
  markStartup('collector.loaded');
  // Export incomplete starts too, without disk work in the ordinary launch path.
  scheduleExport(10_000);
}
