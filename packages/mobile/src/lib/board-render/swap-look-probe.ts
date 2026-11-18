/**
 * A Sentry breadcrumb when Android's swap look probe left the look off
 * (`climbOverlaySwapLookProbe`), so an error report from a phone drawing the
 * shipped swap says why. iOS has no probe and leaves none.
 */
import { addErrorBreadcrumb } from '../error-reporting';
import type { ClimbOverlaySwapLookProbe } from './gpu-native-capability';

type SwapLookProbeBreadcrumb = Parameters<typeof addErrorBreadcrumb>[0];

/**
 * The breadcrumb for a probe that left the look off, or null when it did not
 * (or there was no probe). The result, its milliseconds and the failed step
 * only: no GPU strings, nothing about the climber.
 */
export function swapLookProbeBreadcrumb(probe: ClimbOverlaySwapLookProbe | null): SwapLookProbeBreadcrumb | null {
  if (probe === null) return null;
  if (probe.result !== 'failed' && probe.result !== 'timeout' && probe.result !== 'cached-failed') return null;
  return {
    category: 'board-render',
    message: `Swap look off: probe ${probe.result}`,
    // A stored failure repeats on every launch until the app or GPU driver updates.
    level: probe.result === 'cached-failed' ? 'info' : 'warning',
    data: { result: probe.result, ms: probe.ms, ...(probe.failure ? { failure: probe.failure } : null) },
  };
}

let noted = false;

/** Leaves the breadcrumb once per process. Called when a GPU board mounts, after Sentry has started. */
export function noteSwapLookProbe(probe: ClimbOverlaySwapLookProbe | null): void {
  if (noted) return;
  noted = true;
  const breadcrumb = swapLookProbeBreadcrumb(probe);
  if (breadcrumb) addErrorBreadcrumb(breadcrumb);
}
