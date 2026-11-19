export type ClimbOverlayGPUFailureScope = 'frame' | 'static' | 'context';
export type ClimbOverlayGPUFailure = {
  requestId: string;
  reason: string;
  failureScope?: ClimbOverlayGPUFailureScope;
};

function readApiVersion(): number {
  try {
    // Read the existing public module constant without changing the local
    // native module's fingerprinted source tree. This safety layer can use OTA.
    const { requireOptionalNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    const nativeModule = requireOptionalNativeModule<{ apiVersion?: unknown }>('ClimbOverlayGPU');
    const apiVersion = nativeModule?.apiVersion;
    return typeof apiVersion === 'number' && Number.isSafeInteger(apiVersion) && apiVersion > 0
      ? apiVersion
      : nativeModule
        ? 1
        : 0;
  } catch {
    return 0;
  }
}

export const climbOverlayGpuApiVersion = readApiVersion();

/**
 * 1 when the native view takes each wall-swap frame as the `swapFrame` view
 * command (#7737), else 0. An older binary drops an unknown command without a
 * word, so this constant, not the API version, decides whether to send one.
 */
function readSwapCommandApi(): number {
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    const swapCommandApi = requireOptionalNativeModule<{ swapCommandApi?: unknown }>('ClimbOverlayGPU')?.swapCommandApi;
    return typeof swapCommandApi === 'number' && Number.isSafeInteger(swapCommandApi) && swapCommandApi > 0
      ? swapCommandApi
      : 0;
  } catch {
    return 0;
  }
}

export const climbOverlaySwapCommandApi = readSwapCommandApi();

/**
 * The native swap look (`swapLookVersion`): 2 on iOS and Android binaries that
 * implement it, 0 on older binaries, which would reject its longer swap frames.
 * Current Android binaries compile lazily for an eligible mounted view and
 * fall back to the base swap if the driver rejects the program. Earlier Android
 * binaries probed at startup and may report 0 for an unsupported driver.
 * The player sends its look only from 2 (`play-drawer/player-swap-look.ts`).
 */
function readSwapLookVersion(): number {
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    const version = requireOptionalNativeModule<{ swapLookVersion?: unknown }>('ClimbOverlayGPU')?.swapLookVersion;
    return typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : 0;
  } catch {
    return 0;
  }
}

export const climbOverlaySwapLookVersion = readSwapLookVersion();

/** Historical startup-probe results from earlier Android binaries. */
export type ClimbOverlaySwapLookProbeResult = 'built' | 'failed' | 'timeout' | 'cached-built' | 'cached-failed';

/**
 * Earlier Android binaries expose `swapLookProbe` to explain `swapLookVersion`.
 * Current binaries compile lazily and omit this constant. `cached-*` answers
 * come from an earlier launch on the same GPU
 * driver, app build and look source; a `timeout` is never stored, so the next
 * launch probes again.
 */
export type ClimbOverlaySwapLookProbe = {
  result: ClimbOverlaySwapLookProbeResult;
  /** Milliseconds from the probe's start to its answer; for a timeout, how long it had run when the module stopped waiting. */
  ms: number;
  /** Failed answers only: the step that failed (`compile`, `link`, `no GLES 3.1`, …). */
  failure?: string;
};

const SWAP_LOOK_PROBE_RESULTS: readonly ClimbOverlaySwapLookProbeResult[] = [
  'built',
  'failed',
  'timeout',
  'cached-built',
  'cached-failed',
];

/** The historical constant's value, or null for binaries without a startup probe. */
export function parseSwapLookProbe(value: unknown): ClimbOverlaySwapLookProbe | null {
  if (typeof value !== 'object' || value === null) return null;
  const { result, ms, failure } = value as { result?: unknown; ms?: unknown; failure?: unknown };
  const knownResult = SWAP_LOOK_PROBE_RESULTS.find((candidate) => candidate === result);
  if (knownResult === undefined || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return typeof failure === 'string' && failure.length > 0
    ? { result: knownResult, ms, failure }
    : { result: knownResult, ms };
}

function readSwapLookProbe(): ClimbOverlaySwapLookProbe | null {
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    return parseSwapLookProbe(
      requireOptionalNativeModule<{ swapLookProbe?: unknown }>('ClimbOverlayGPU')?.swapLookProbe,
    );
  } catch {
    return null;
  }
}

/** Earlier Android binaries only; null on iOS and binaries with lazy shader compilation. */
export const climbOverlaySwapLookProbe = readSwapLookProbe();
