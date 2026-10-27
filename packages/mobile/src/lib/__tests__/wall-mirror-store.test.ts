// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  __resetWallMirrorFlipForTests,
  getWallMirrorFlip,
  retainWallMirrorFlip,
  setWallMirrorFlip,
  useWallMirrorFlip,
  wallMirrorFlipFor,
} from '../wall-mirror-store';

function makeBluetooth() {
  return { setMirrorIntent: vi.fn(), retainMirrorIntentFor: vi.fn() };
}

describe('wall-mirror-store', () => {
  beforeEach(__resetWallMirrorFlipForTests);

  it('starts with nobody having flipped anything', () => {
    expect(getWallMirrorFlip()).toBeNull();
    expect(wallMirrorFlipFor(getWallMirrorFlip(), 'climb-a')).toBeUndefined();
  });

  it('flips a climb here and in the BLE intent together, and back again', () => {
    const bluetooth = makeBluetooth();
    const { result } = renderHook(() => useWallMirrorFlip());
    act(() => setWallMirrorFlip(bluetooth, 'climb-a', true));
    expect(result.current).toEqual({ climbUuid: 'climb-a', mirrored: true });
    expect(bluetooth.setMirrorIntent).toHaveBeenLastCalledWith('climb-a', true);
    act(() => setWallMirrorFlip(bluetooth, 'climb-a', false));
    // "Said un-mirrored" stays a stated value, never "nobody said".
    expect(wallMirrorFlipFor(result.current, 'climb-a')).toBe(false);
    expect(bluetooth.setMirrorIntent).toHaveBeenLastCalledWith('climb-a', false);
  });

  it('holds one slot: a tap on another climb takes it over', () => {
    setWallMirrorFlip(null, 'climb-a', true);
    setWallMirrorFlip(null, 'climb-b', true);
    expect(wallMirrorFlipFor(getWallMirrorFlip(), 'climb-a')).toBeUndefined();
    expect(wallMirrorFlipFor(getWallMirrorFlip(), 'climb-b')).toBe(true);
  });

  it('keeps a flip on the climb the player settles on, and drops one parked on another', () => {
    const bluetooth = makeBluetooth();
    setWallMirrorFlip(bluetooth, 'climb-a', true);
    retainWallMirrorFlip(bluetooth, 'climb-a');
    expect(getWallMirrorFlip()).toEqual({ climbUuid: 'climb-a', mirrored: true });
    expect(bluetooth.retainMirrorIntentFor).toHaveBeenLastCalledWith('climb-a');
    retainWallMirrorFlip(bluetooth, 'climb-b');
    expect(getWallMirrorFlip()).toBeNull();
    expect(bluetooth.retainMirrorIntentFor).toHaveBeenLastCalledWith('climb-b');
  });

  it('re-renders readers only when the slot changes', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useWallMirrorFlip();
    });
    const afterMount = renders;
    act(() => setWallMirrorFlip(null, 'climb-a', true));
    expect(renders).toBe(afterMount + 1);
    // The same flip again, and a retain on its own climb, change nothing.
    act(() => setWallMirrorFlip(null, 'climb-a', true));
    act(() => retainWallMirrorFlip(null, 'climb-a'));
    expect(renders).toBe(afterMount + 1);
  });

  it('still states the intent to the provider when the slot already says so', () => {
    // The provider's own dedup decides whether the wall needs a write.
    const bluetooth = makeBluetooth();
    setWallMirrorFlip(bluetooth, 'climb-a', true);
    setWallMirrorFlip(bluetooth, 'climb-a', true);
    expect(bluetooth.setMirrorIntent).toHaveBeenCalledTimes(2);
  });
});
