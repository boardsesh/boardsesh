import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { ClimbOverlayGPUReady } from '../../../modules/climb-overlay-gpu/src';
import type { ClimbOverlayGPUFailureScope } from './gpu-native-capability';
import { track } from '../analytics';
import { isProductAnalyticsGranted } from '../consent-state';
import { AURA_GPU_FAMILIES } from './gpu-rollout';

export type GpuFallbackReason =
  | 'presentation-timeout'
  | 'resource-limit'
  | 'unsupported-frame'
  | 'context-failed'
  | 'preparation-failed'
  | 'render-failed'
  | 'cancelled';

export function classifyGpuFallback(reason: unknown): GpuFallbackReason {
  if (typeof reason !== 'string') return 'render-failed';
  const normalized = reason.toLowerCase();
  if (normalized.includes('cancel') || normalized.includes('superseded')) return 'cancelled';
  if (normalized.includes('timeout')) return 'presentation-timeout';
  if (/unknown.role|unsupported.role|unsupported.frame|too.many.holds|active.hold/.test(normalized))
    return 'unsupported-frame';
  if (/budget|resource.limit|memory|allocation/.test(normalized)) return 'resource-limit';
  if (/context|egl|device.unavailable/.test(normalized)) return 'context-failed';
  if (/prepar|atlas|config|manifest/.test(normalized)) return 'preparation-failed';
  return 'render-failed';
}

// Binaries before native API 5 label no failure scope. Only these raw reasons
// repeat for the same static config on the same binary and phone: a config or
// atlas this build rejects, or a GPU feature the phone lacks. Everything else
// (command errors, GPU timeouts, allocation and surface failures) can pass on
// the next attempt, so it falls back for the current frames only.
const DETERMINISTIC_UNSCOPED_REASONS = [
  'invalid render config',
  'atlas preparation rejected config',
  // Android API 3: Rust rejected the config (BoardRendererBridge.prepareAtlas).
  'gpu atlas rejected config',
  // Android API 3: Kotlin's default require() message. That build only uses a
  // bare require() to validate the atlas Rust produced for the config.
  'failed requirement.',
  'invalid atlas header',
  'invalid atlas manifest size',
  'invalid atlas layout',
  'invalid atlas hold',
  'invalid atlas vector',
  'invalid atlas offset',
  'gpu config too large',
  'gpu storage or viewport limit exceeded',
  'metal unavailable',
  'gles3.1 required',
  'fragment storage buffers unavailable',
  'frame timestamp extension unavailable',
];

/** Only a 'static' scope is remembered across launches; a native label wins. */
export function resolveGpuFailureScope(
  nativeScope: unknown,
  rawReason: unknown,
  reason: GpuFallbackReason,
): ClimbOverlayGPUFailureScope {
  if (nativeScope === 'frame' || nativeScope === 'context' || nativeScope === 'static') return nativeScope;
  if (reason === 'unsupported-frame') return 'frame';
  const normalized = typeof rawReason === 'string' ? rawReason.toLowerCase() : '';
  return DETERMINISTIC_UNSCOPED_REASONS.some((known) => normalized.includes(known)) ? 'static' : 'context';
}

const SAMPLE_RATE = 0.1;
const MAX_DECISIONS = 128;
const decisions = new Set<string>();

type Context = { boardName: string; apiVersion: number; surface: 'player' | 'editor' };
function sampled(key: string): boolean {
  if (!isProductAnalyticsGranted() || decisions.has(key) || decisions.size >= MAX_DECISIONS) return false;
  decisions.add(key);
  return Math.random() < SAMPLE_RATE;
}

function properties(context: Context) {
  return {
    board_name: AURA_GPU_FAMILIES.find((family) => family === context.boardName.toLowerCase()) ?? 'unknown',
    api_version: Number.isSafeInteger(context.apiVersion) ? context.apiVersion : 0,
    surface: context.surface,
    sample_rate: SAMPLE_RATE,
  };
}

function emitDiagnostic(name: string, eventProperties: Parameters<typeof track>[1]): void {
  try {
    track(name, eventProperties);
  } catch {
    // Optional diagnostics cannot prevent presentation or the PNG fallback.
  }
}

/** Request fencing happens before this call. No raw reason, frame or key is sent. */
export function reportGpuFallback(
  context: Context,
  requestId: string,
  reason: GpuFallbackReason,
  failureScope: ClimbOverlayGPUFailureScope,
): void {
  if (reason === 'cancelled' || !sampled(`failure:${requestId}`)) return;
  emitDiagnostic(SHARED_EVENTS.AuraGpuFallback, { ...properties(context), reason, failure_scope: failureScope });
}

/** Cold-preparation observations inform whether the parked CDN work is needed. */
export function reportGpuPreparation(context: Context, ready: ClimbOverlayGPUReady): void {
  if (ready.atlasCacheHit || !sampled(`prepare:${ready.requestId}`)) return;
  const bounded = (measurement: number) =>
    Number.isFinite(measurement) ? Math.max(0, Math.min(measurement, 60_000)) : null;
  emitDiagnostic(SHARED_EVENTS.AuraGpuPrepared, {
    ...properties(context),
    prepare_ms: bounded(ready.prepareMs),
    upload_ms: bounded(ready.uploadMs),
    atlas_bytes: Number.isSafeInteger(ready.atlasBytes) && ready.atlasBytes >= 0 ? ready.atlasBytes : null,
  });
}

export type GpuFirstHoldsSource = 'gpu' | 'cached-png-bridge' | 'hedged-png';

/**
 * How a GPU request on a board without a frame of its drawing first showed its
 * holds: the GPU frame itself, a PNG that was already in the cache, or a PNG
 * the board rendered (after the grace period, or at once while the drawing was
 * `cold`: not yet presented in this process). One sampling decision per
 * request; nothing runs per frame.
 */
export function reportGpuFirstHolds(
  context: Context,
  requestId: string,
  source: GpuFirstHoldsSource,
  firstHoldsMs: number,
  cold: boolean,
): void {
  if (!sampled(`first-holds:${requestId}`)) return;
  emitDiagnostic(SHARED_EVENTS.AuraGpuFirstHolds, {
    ...properties(context),
    source,
    cold,
    first_holds_ms: Number.isFinite(firstHoldsMs) ? Math.round(Math.max(0, Math.min(firstHoldsMs, 60_000))) : null,
  });
}
