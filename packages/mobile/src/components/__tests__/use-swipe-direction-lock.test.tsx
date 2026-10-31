// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
type Touch = { absoluteX: number; absoluteY: number };
type TouchEvent = { allTouches: Touch[] };
type Manager = { fail: () => void; end: () => void };
type Handler = (event: TouchEvent, manager: Manager) => void;
const native = vi.hoisted(() => ({ handlers: {} as Record<string, Handler> }));
vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Manual: () => {
      const builder: Record<string, (handler: Handler) => typeof builder> = {};
      for (const method of ['onTouchesDown', 'onTouchesMove', 'onTouchesUp', 'onTouchesCancelled']) {
        builder[method] = (handler) => {
          native.handlers[method] = handler;
          return builder;
        };
      }
      return builder;
    },
  },
}));
vi.mock('react-native-reanimated', () => ({ useSharedValue: (initial: unknown) => ({ value: initial }) }));
import { useSwipeDirectionLock } from '../use-swipe-direction-lock';

function touch(x: number, y: number): TouchEvent {
  return { allTouches: [{ absoluteX: x, absoluteY: y }] };
}

function startTouch() {
  renderHook(() => useSwipeDirectionLock());
  const manager = { fail: vi.fn(), end: vi.fn() };
  native.handlers.onTouchesDown(touch(100, 100), manager);
  return manager;
}

describe('swipe direction lock', () => {
  it('releases the swipe when the finger moves sideways first', () => {
    const manager = startTouch();
    native.handlers.onTouchesMove(touch(106, 102), manager);
    expect(manager.fail).not.toHaveBeenCalled();
    native.handlers.onTouchesMove(touch(112, 103), manager);
    expect(manager.fail).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'stationary tap', releaseX: 100, releaseY: 100 },
    { name: 'small horizontal drift', releaseX: 106, releaseY: 102 },
    { name: 'small vertical drift', releaseX: 102, releaseY: 106 },
  ])('fails an undecided $name so a waiting tap can close the row', ({ releaseX, releaseY }) => {
    const manager = startTouch();
    native.handlers.onTouchesMove(touch(releaseX, releaseY), manager);
    native.handlers.onTouchesUp(touch(releaseX, releaseY), manager);
    expect(manager.fail).toHaveBeenCalledOnce();
    expect(manager.end).not.toHaveBeenCalled();
  });

  it('forgets a previous vertical decision when a new stationary touch starts', () => {
    const manager = startTouch();
    native.handlers.onTouchesMove(touch(103, 112), manager);
    native.handlers.onTouchesUp(touch(103, 112), manager);
    expect(manager.end).toHaveBeenCalledOnce();
    manager.end.mockClear();
    native.handlers.onTouchesDown(touch(200, 200), manager);
    native.handlers.onTouchesUp(touch(200, 200), manager);
    expect(manager.fail).toHaveBeenCalledOnce();
    expect(manager.end).not.toHaveBeenCalled();
  });

  it('holds the swipe off for the whole touch once the finger moves vertically first', () => {
    const manager = startTouch();
    native.handlers.onTouchesMove(touch(103, 112), manager);
    // A long scroll drifts sideways well past the swipe's activation offset.
    native.handlers.onTouchesMove(touch(160, 130), manager);
    expect(manager.fail).not.toHaveBeenCalled();
    native.handlers.onTouchesUp(touch(160, 130), manager);
    expect(manager.end).toHaveBeenCalledOnce();
  });

  it('ends on a cancelled touch so a waiting swipe never fires', () => {
    const manager = startTouch();
    native.handlers.onTouchesCancelled(touch(100, 100), manager);
    expect(manager.end).toHaveBeenCalledOnce();
    expect(manager.fail).not.toHaveBeenCalled();
  });
});
