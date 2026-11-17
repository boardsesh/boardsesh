/**
 * "Play all variants" as a small pure state machine. The screen feeds it events
 * and runs the effects it returns (timers, selecting a variant, playing the
 * showcase script, logging), so the sequencing is testable without React.
 *
 * Per variant: select it, wait until the board reports how it draws (max 2 s),
 * hold 800 ms so the caption is readable, play the showcase script, wait for the
 * script to finish, settle 600 ms, next. The caption switches with each variant.
 */

export const AUTOPLAY_TIMINGS = {
  readyTimeoutMs: 2000,
  captionHoldMs: 800,
  settleMs: 600,
} as const;

export type AutoplayPhase = 'idle' | 'awaiting-ready' | 'caption-hold' | 'playing' | 'settling' | 'done';

export type AutoplayState = {
  phase: AutoplayPhase;
  queue: readonly string[];
  /** Index into `queue` of the variant now running. */
  index: number;
};

export type AutoplayEvent =
  | { type: 'start'; variantIds: readonly string[] }
  | { type: 'ready' }
  | { type: 'ready-timeout' }
  | { type: 'hold-done' }
  | { type: 'script-done' }
  | { type: 'settle-done' }
  | { type: 'cancel' };

export type AutoplayEffect =
  | { kind: 'select-variant'; variantId: string }
  | { kind: 'play-script' }
  | { kind: 'stop-script' }
  /** Dispatch `event` after `ms`. Superseded timers are the screen's to cancel. */
  | { kind: 'after'; ms: number; event: AutoplayEvent };

export type AutoplayStep = { state: AutoplayState; effects: AutoplayEffect[] };

export const AUTOPLAY_IDLE: AutoplayState = { phase: 'idle', queue: [], index: 0 };

function beginSegment(queue: readonly string[], index: number): AutoplayStep {
  const variantId = queue[index];
  return {
    state: { phase: 'awaiting-ready', queue, index },
    effects: [
      { kind: 'select-variant', variantId },
      { kind: 'after', ms: AUTOPLAY_TIMINGS.readyTimeoutMs, event: { type: 'ready-timeout' } },
    ],
  };
}

function finish(queue: readonly string[], index: number): AutoplayStep {
  return { state: { phase: 'done', queue, index }, effects: [] };
}

export function stepAutoplay(state: AutoplayState, event: AutoplayEvent): AutoplayStep {
  const stay: AutoplayStep = { state, effects: [] };
  switch (event.type) {
    case 'start':
      if (event.variantIds.length === 0) return finish([], 0);
      return beginSegment(event.variantIds, 0);
    case 'ready':
    case 'ready-timeout':
      if (state.phase !== 'awaiting-ready') return stay;
      return {
        state: { ...state, phase: 'caption-hold' },
        effects: [{ kind: 'after', ms: AUTOPLAY_TIMINGS.captionHoldMs, event: { type: 'hold-done' } }],
      };
    case 'hold-done':
      if (state.phase !== 'caption-hold') return stay;
      return { state: { ...state, phase: 'playing' }, effects: [{ kind: 'play-script' }] };
    case 'script-done':
      if (state.phase !== 'playing') return stay;
      return {
        state: { ...state, phase: 'settling' },
        effects: [{ kind: 'after', ms: AUTOPLAY_TIMINGS.settleMs, event: { type: 'settle-done' } }],
      };
    case 'settle-done':
      if (state.phase !== 'settling') return stay;
      return state.index + 1 < state.queue.length
        ? beginSegment(state.queue, state.index + 1)
        : finish(state.queue, state.index);
    case 'cancel':
      if (state.phase === 'idle' || state.phase === 'done') return stay;
      return {
        state: { ...state, phase: 'idle' },
        effects: [{ kind: 'stop-script' }],
      };
  }
}

export function isAutoplayRunning(state: AutoplayState): boolean {
  return state.phase !== 'idle' && state.phase !== 'done';
}

/** The variant ids a deep link's `autoplay` value plays, in order. */
export function autoplayQueue(autoplay: string, availableVariantIds: readonly string[]): string[] {
  if (autoplay === 'all') return [...availableVariantIds];
  return availableVariantIds.includes(autoplay) ? [autoplay] : [];
}
