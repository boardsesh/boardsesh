// @vitest-environment jsdom
// Owner decision A: the MiniPlayer's bulb on an unlit last pick opens the
// player on it, and once that preview lands Put on board is pressed for it,
// once, through the wall button's own handler.
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { putOnBoardIntentPresses, usePutOnBoardIntent, type PutOnBoardIntentInputs } from '../use-put-on-board-intent';
import type { WallControlAction } from '../wall-control';

function inputs(over: Partial<PutOnBoardIntentInputs> = {}): PutOnBoardIntentInputs {
  return {
    intendedFor: 'queue-pick',
    clear: vi.fn(),
    previewItemUuid: 'queue-pick',
    ready: true,
    press: vi.fn(),
    ...over,
  };
}

describe('usePutOnBoardIntent', () => {
  it('presses Put on board once the asked-for preview is on screen', () => {
    const props = inputs();
    renderHook(usePutOnBoardIntent, { initialProps: props });
    expect(props.press).toHaveBeenCalledOnce();
    expect(props.clear).toHaveBeenCalledOnce();
  });

  // In a crew the busy-wall question needs the latch's snapshot first.
  it('waits until it is ready, then presses', () => {
    const waiting = inputs({ ready: false });
    const { rerender } = renderHook(usePutOnBoardIntent, { initialProps: waiting });
    expect(waiting.press).not.toHaveBeenCalled();
    rerender({ ...waiting, ready: true });
    expect(waiting.press).toHaveBeenCalledOnce();
  });

  it('drops the request for a preview that is not the one asked about', () => {
    const props = inputs({ previewItemUuid: 'queue-other' });
    renderHook(usePutOnBoardIntent, { initialProps: props });
    expect(props.press).not.toHaveBeenCalled();
    expect(props.clear).toHaveBeenCalledOnce();
  });

  it('does nothing without a request', () => {
    const props = inputs({ intendedFor: null });
    renderHook(usePutOnBoardIntent, { initialProps: props });
    expect(props.press).not.toHaveBeenCalled();
    expect(props.clear).not.toHaveBeenCalled();
  });
});

// The bar's bulb runs the button's tap (owner, 2026-11-03), stops included, so
// a Put on board request that lands on You are driving the wall must not stop
// the drive: the climb on screen is lit already.
describe('putOnBoardIntentPresses', () => {
  it.each(['put_on_wall', 'connect', 'relight', 'move_to_board', 'relay', 'disconnect'] as WallControlAction[])(
    'presses for %s, as before',
    (action) => {
      expect(putOnBoardIntentPresses(action)).toBe(true);
    },
  );

  it.each(['noop', 'stop_driving', 'stop_window'] as WallControlAction[])('never presses for %s', (action) => {
    expect(putOnBoardIntentPresses(action)).toBe(false);
  });
});
