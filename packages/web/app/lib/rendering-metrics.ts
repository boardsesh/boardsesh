import { track } from '@vercel/analytics';

export type RenderContext = 'thumbnail' | 'card' | 'full-board' | 'feed';

// Cap render events per session to avoid flooding analytics on long lists.
// Counter persists across SPA navigations (only resets on full page load).
const MAX_RENDER_EVENTS = 5;
let renderEventCount = 0;
let errorEventCount = 0;

export function trackRenderComplete(durationMs: number, context: RenderContext, renderer: 'svg' | 'wasm') {
  if (renderEventCount >= MAX_RENDER_EVENTS) return;
  renderEventCount++;
  track('Board Render Complete', {
    durationMs: Math.round(durationMs),
    context,
    renderer,
  });
}

export function trackRenderError(context: RenderContext, renderer: 'svg' | 'wasm') {
  if (errorEventCount >= MAX_RENDER_EVENTS) return;
  errorEventCount++;
  track('Board Render Error', { context, renderer });
}

const MAX_LIST_EVENTS = 10;
let listEventCount = 0;

export function trackListBatchRender(
  durationMs: number,
  props: {
    viewMode: 'grid' | 'list';
    renderer: 'svg' | 'wasm';
    batchSize: number;
    totalItems: number;
    isInitial: boolean;
  },
) {
  if (listEventCount >= MAX_LIST_EVENTS) return;
  listEventCount++;
  track('List Batch Render', {
    durationMs: Math.round(durationMs),
    ...props,
  });
}
