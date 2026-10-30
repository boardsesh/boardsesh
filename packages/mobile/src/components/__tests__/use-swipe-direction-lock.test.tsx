// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
type Touch = { absoluteX: number; absoluteY: number };
type TouchEvent = { handlerTag: number; allTouches: Touch[] };
type Handler = (event: TouchEvent) => void;
const native = vi.hoisted(() => ({
  config: {} as Record<string, Handler>,
  manager: { fail: vi.fn(), deactivate: vi.fn() },
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureStateManager: native.manager,
  useManualGesture: (config: Record<string, Handler>) => {
    native.config = config;
    return { type: 'manual' };
  },
}));
vi.mock('react-native-reanimated', () => ({ useSharedValue: (initial: unknown) => ({ value: initial }) }));
import { useSwipeDirectionLock } from '../use-swipe-direction-lock';

const TAG = 7;

function touch(x: number, y: number): TouchEvent {
  return { handlerTag: TAG, allTouches: [{ absoluteX: x, absoluteY: y }] };
}

function startTouch() {
  renderHook(() => useSwipeDirectionLock());
  native.config.onTouchesDown(touch(100, 100));
  return native.manager;
}

describe('swipe direction lock', () => {
  beforeEach(() => {
    native.manager.fail.mockClear();
    native.manager.deactivate.mockClear();
  });

  it('releases the swipe when the finger moves sideways first', () => {
    const manager = startTouch();
    native.config.onTouchesMove(touch(106, 102));
    expect(manager.fail).not.toHaveBeenCalled();
    native.config.onTouchesMove(touch(112, 103));
    expect(manager.fail).toHaveBeenCalledExactlyOnceWith(TAG);
  });

  it('holds the swipe off for the whole touch once the finger moves vertically first', () => {
    const manager = startTouch();
    native.config.onTouchesMove(touch(103, 112));
    // A long scroll drifts sideways well past the swipe's activation offset.
    native.config.onTouchesMove(touch(160, 130));
    expect(manager.fail).not.toHaveBeenCalled();
    native.config.onTouchesUp(touch(160, 130));
    expect(manager.deactivate).toHaveBeenCalledExactlyOnceWith(TAG);
  });

  it('ends on a cancelled touch so a waiting swipe never fires', () => {
    const manager = startTouch();
    native.config.onTouchesCancel(touch(100, 100));
    expect(manager.deactivate).toHaveBeenCalledExactlyOnceWith(TAG);
    expect(manager.fail).not.toHaveBeenCalled();
  });
});
