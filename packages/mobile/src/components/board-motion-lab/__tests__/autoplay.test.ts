import { describe, expect, it } from 'vitest';
import {
  AUTOPLAY_IDLE,
  autoplayQueue,
  stepAutoplay,
  type AutoplayEffect,
  type AutoplayEvent,
  type AutoplayState,
} from '../autoplay';

function run(state: AutoplayState, events: AutoplayEvent[]) {
  const effects: AutoplayEffect[] = [];
  let current = state;
  for (const event of events) {
    const step = stepAutoplay(current, event);
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
    const started = stepAutoplay(AUTOPLAY_IDLE, { type: 'start', variantIds: ['a'] }).state;
    expect(stepAutoplay(started, { type: 'script-done' }).effects).toEqual([]);
    expect(stepAutoplay(started, { type: 'settle-done' }).state).toBe(started);
  });

  it('finishes straight away with nothing to play', () => {
    const step = stepAutoplay(AUTOPLAY_IDLE, { type: 'start', variantIds: [] });
    expect(step.state.phase).toBe('done');
    expect(step.effects).toEqual([]);
  });

  it('cancel stops the script and returns to idle', () => {
    const started = stepAutoplay(AUTOPLAY_IDLE, { type: 'start', variantIds: ['a'] }).state;
    const step = stepAutoplay(started, { type: 'cancel' });
    expect(step.state.phase).toBe('idle');
    expect(step.effects).toContainEqual({ kind: 'stop-script' });
  });
});

describe('autoplayQueue', () => {
  it('plays all, one, or nothing for an unknown id', () => {
    expect(autoplayQueue('all', ['a', 'b'])).toEqual(['a', 'b']);
    expect(autoplayQueue('b', ['a', 'b'])).toEqual(['b']);
    expect(autoplayQueue('z', ['a', 'b'])).toEqual([]);
  });
});
