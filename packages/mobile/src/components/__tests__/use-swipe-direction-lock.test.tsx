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

  it.each([
    { name: 'stationary tap', releaseX: 100, releaseY: 100 },
    { name: 'small horizontal drift', releaseX: 106, releaseY: 102 },
    { name: 'small vertical drift', releaseX: 102, releaseY: 106 },
  ])('fails an undecided $name so a waiting tap can close the row', ({ releaseX, releaseY }) => {
    const manager = startTouch();
    native.config.onTouchesMove(touch(releaseX, releaseY));
    native.config.onTouchesUp(touch(releaseX, releaseY));
    expect(manager.fail).toHaveBeenCalledExactlyOnceWith(TAG);
    expect(manager.deactivate).not.toHaveBeenCalled();
  });

  it('forgets a previous vertical decision when a new stationary touch starts', () => {
    const manager = startTouch();
    native.config.onTouchesMove(touch(103, 112));
    native.config.onTouchesUp(touch(103, 112));
    expect(manager.deactivate).toHaveBeenCalledExactlyOnceWith(TAG);
    manager.deactivate.mockClear();
    native.config.onTouchesDown(touch(200, 200));
    native.config.onTouchesUp(touch(200, 200));
    expect(manager.fail).toHaveBeenCalledExactlyOnceWith(TAG);
    expect(manager.deactivate).not.toHaveBeenCalled();
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
