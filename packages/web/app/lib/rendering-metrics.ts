import { track } from '@/app/lib/analytics';

export type RenderContext = 'thumbnail' | 'card' | 'full-board' | 'feed';

const MAX_ERROR_EVENTS = 5;
let errorEventCount = 0;

export function trackRenderError(context: RenderContext, renderer: 'svg' | 'wasm') {
  if (errorEventCount >= MAX_ERROR_EVENTS) return;
  errorEventCount++;
  track('Board Render Error', { context, renderer });
}

// Fires once per session the first time the Web Worker renderer is disabled
// (e.g. WKWebView script-load failure). Lets us measure how often users fall
// back to the SSR image-layer tier for the whole session.
let workerDisabledReported = false;
export type WorkerDisabledReason = 'load-failed' | 'construct-failed';
export function trackWorkerRenderingDisabled(reason: WorkerDisabledReason) {
  if (workerDisabledReported) return;
  workerDisabledReported = true;
  track('Board Worker Rendering Disabled', { reason });
}
