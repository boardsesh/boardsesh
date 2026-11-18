import { describe, expect, it } from 'vitest';
import {
  AUTOPLAY_IDLE,
  AUTOPLAY_TIMINGS,
  autoplayQueue,
  scriptTimeoutMs,
  stepAutoplay,
  type AutoplayEffect,
  type AutoplayEvent,
  type AutoplayPace,
  type AutoplayState,
} from '../autoplay';

const PACE: AutoplayPace = { scriptTimeoutMs: 5000 };

function run(state: AutoplayState, events: AutoplayEvent[], pace: AutoplayPace = PACE) {
  const effects: AutoplayEffect[] = [];
  let current = state;
  for (const event of events) {
    const step = stepAutoplay(current, event, pace);
    current = step.state;
    effects.push(...step.effects);
  }
  return { state: current, effects };
}

describe('stepAutoplay', () => {
  it('walks each variant through ready, hold, script, settle', () => {
    const { state, effects } = run(AUTOPLAY_IDLE, [
      { type: 'start', variantIds: ['a', 'b'] },
      { type: 'ready' },
      { type: 'hold-done' },
      { type: 'script-done' },
      { type: 'settle-done' },
      { type: 'ready-timeout' },
      { type: 'hold-done' },
      { type: 'script-done' },
      { type: 'settle-done' },
    ]);
    expect(state.phase).toBe('done');
    expect(effects.filter((e) => e.kind === 'select-variant')).toEqual([
      { kind: 'select-variant', variantId: 'a' },
      { kind: 'select-variant', variantId: 'b' },
    ]);
    expect(effects.filter((e) => e.kind === 'play-script')).toHaveLength(2);
  });

  it('ignores events from the wrong phase', () => {
    const started = stepAutoplay(AUTOPLAY_IDLE, { type: 'start', variantIds: ['a'] }, PACE).state;
    expect(stepAutoplay(started, { type: 'script-done' }, PACE).effects).toEqual([]);
    expect(stepAutoplay(started, { type: 'script-timeout' }, PACE).effects).toEqual([]);
    expect(stepAutoplay(started, { type: 'settle-done' }, PACE).state).toBe(started);
  });

  it('finishes straight away with nothing to play', () => {
    const step = stepAutoplay(AUTOPLAY_IDLE, { type: 'start', variantIds: [] }, PACE);
    expect(step.state.phase).toBe('done');
    expect(step.effects).toEqual([]);
  });

  it('cancel stops the script and returns to idle', () => {
    const started = stepAutoplay(AUTOPLAY_IDLE, { type: 'start', variantIds: ['a'] }, PACE).state;
    const step = stepAutoplay(started, { type: 'cancel' }, PACE);
    expect(step.state.phase).toBe('idle');
    expect(step.effects).toContainEqual({ kind: 'stop-script' });
  });

  it('times the script by the pace it is given when the script starts', () => {
    const holding = run(AUTOPLAY_IDLE, [{ type: 'start', variantIds: ['a'] }, { type: 'ready' }]).state;
    const step = stepAutoplay(holding, { type: 'hold-done' }, { scriptTimeoutMs: 9000 });
    expect(step.state.phase).toBe('playing');
    expect(step.effects).toEqual([
      { kind: 'play-script' },
      { kind: 'after', ms: 9000, event: { type: 'script-timeout' } },
    ]);
  });

  it('a script that never reports done is stopped at its timeout, and Play all moves on', () => {
    const { state, effects } = run(AUTOPLAY_IDLE, [
      { type: 'start', variantIds: ['a', 'b'] },
      { type: 'ready' },
      { type: 'hold-done' },
      { type: 'script-timeout' },
      { type: 'settle-done' },
    ]);
    expect(effects).toContainEqual({ kind: 'stop-script' });
    expect(state).toMatchObject({ phase: 'awaiting-ready', index: 1 });
    expect(effects.filter((effect) => effect.kind === 'select-variant').at(-1)).toEqual({
      kind: 'select-variant',
      variantId: 'b',
    });
  });

  it('a timeout after the script reported done changes nothing', () => {
    const settling = run(AUTOPLAY_IDLE, [
      { type: 'start', variantIds: ['a'] },
      { type: 'ready' },
      { type: 'hold-done' },
      { type: 'script-done' },
    ]).state;
    expect(stepAutoplay(settling, { type: 'script-timeout' }, PACE)).toEqual({ state: settling, effects: [] });
  });
});

describe('scriptTimeoutMs', () => {
  it('stretches the script by the slowdown and adds the margin', () => {
    expect(scriptTimeoutMs(3000, 1)).toBe(3000 + AUTOPLAY_TIMINGS.scriptMarginMs);
    expect(scriptTimeoutMs(3000, 4)).toBe(12000 + AUTOPLAY_TIMINGS.scriptMarginMs);
  });
});

describe('autoplayQueue', () => {
  it('plays all, one, or nothing for an unknown id', () => {
    expect(autoplayQueue('all', ['a', 'b'])).toEqual(['a', 'b']);
    expect(autoplayQueue('b', ['a', 'b'])).toEqual(['b']);
    expect(autoplayQueue('z', ['a', 'b'])).toEqual([]);
  });
});
