import { track } from '@/app/lib/analytics';

export type RenderContext = 'thumbnail' | 'card' | 'full-board' | 'feed';

const MAX_ERROR_EVENTS = 5;
let errorEventCount = 0;

export function trackRenderError(context: RenderContext, renderer: 'svg' | 'wasm') {
  if (errorEventCount >= MAX_ERROR_EVENTS) return;
  errorEventCount++;
  track('Board Render Error', { context, renderer });
}
