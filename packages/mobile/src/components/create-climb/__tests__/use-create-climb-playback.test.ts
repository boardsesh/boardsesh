// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import { useCreateClimbPlayback } from '../use-create-climb-playback';

const START = { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' };
const HAND = { state: 'HAND' as const, color: '#00FFFF', displayColor: '#00FFFF' };

const frameOne: LitUpHoldsMap = { 100: START, 200: HAND };
const frameTwo: LitUpHoldsMap = { 100: START, 200: HAND, 300: HAND };
const frameThree: LitUpHoldsMap = { 100: START, 200: HAND, 300: HAND, 400: HAND };

type Props = { frames: LitUpHoldsMap[]; currentFrameIndex: number; goToFrame: (index: number) => void };

function renderPlayback(initialProps: Props) {
  return renderHook(
    (props: Props) =>
      useCreateClimbPlayback({
        frames: props.frames,
        boardName: 'kilter',
        currentFrameIndex: props.currentFrameIndex,
        goToFrame: props.goToFrame,
      }),
    { initialProps },
  );
}

describe('useCreateClimbPlayback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not animatable for a single-frame boulder', () => {
    const { result } = renderPlayback({ frames: [frameOne], currentFrameIndex: 0, goToFrame: vi.fn() });
    expect(result.current.isAnimatable).toBe(false);
  });

  it('is animatable once the climb has a second frame', () => {
    const { result } = renderPlayback({ frames: [frameOne, frameTwo], currentFrameIndex: 0, goToFrame: vi.fn() });
    expect(result.current.isAnimatable).toBe(true);
  });

  it('exposes the active frame as a flat BLE string', () => {
    const { result } = renderPlayback({ frames: [frameOne, frameTwo], currentFrameIndex: 0, goToFrame: vi.fn() });
    // Kilter canonical codes: STARTING 42, HAND 43. No commas, quotes or x tokens.
    expect(result.current.currentFrameString).toBe('p100r42p200r43');
  });

  it('drives the editor cursor while playing', () => {
    const goToFrame = vi.fn();
    const { result } = renderPlayback({
      frames: [frameOne, frameTwo, frameThree],
      currentFrameIndex: 0,
      goToFrame,
    });

    act(() => {
      result.current.play();
    });
    expect(result.current.isPlaying).toBe(true);

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(goToFrame).toHaveBeenCalledWith(1);
  });

  it('re-anchors the engine when the editor cursor moves while paused', () => {
    // A paint / duplicate / delete moves the reducer cursor; the engine has to
    // follow so the next play() starts from the frame on screen.
    const { result, rerender } = renderPlayback({
      frames: [frameOne, frameTwo, frameThree],
      currentFrameIndex: 0,
      goToFrame: vi.fn(),
    });
    expect(result.current.currentFrameString).toBe('p100r42p200r43');

    rerender({ frames: [frameOne, frameTwo, frameThree], currentFrameIndex: 2, goToFrame: vi.fn() });
    expect(result.current.currentFrameString).toBe('p100r42p200r43p300r43p400r43');
  });

  it('moves both the editor cursor and the engine on a transport seek', () => {
    const goToFrame = vi.fn();
    const frames = [frameOne, frameTwo, frameThree];
    const { result, rerender } = renderPlayback({ frames, currentFrameIndex: 0, goToFrame });

    act(() => {
      result.current.seek(2);
    });
    // The editor reducer owns the cursor, so the caller moves it and the screen
    // re-renders with the new index — mirror that here.
    expect(goToFrame).toHaveBeenCalledWith(2);
    rerender({ frames, currentFrameIndex: 2, goToFrame });

    expect(result.current.currentFrameString).toBe('p100r42p200r43p300r43p400r43');
  });

  it('replays from the first frame when play is pressed on the last one', () => {
    // Duplicate lands the cursor on the new last frame, so this is the state
    // right after every Duplicate — pressing play must not immediately stop.
    const goToFrame = vi.fn();
    const { result } = renderPlayback({
      frames: [frameOne, frameTwo, frameThree],
      currentFrameIndex: 2,
      goToFrame,
    });

    act(() => {
      result.current.play();
    });
    expect(result.current.isPlaying).toBe(true);
    expect(result.current.currentFrameString).toBe('p100r42p200r43');
  });

  it('pauses and resets to the first frame when a paint stroke changes the frames', () => {
    // The engine keys its reset on the frame strings, so editing while playing
    // stops the clock rather than animating a stale list.
    const { result, rerender } = renderPlayback({
      frames: [frameOne, frameTwo],
      currentFrameIndex: 0,
      goToFrame: vi.fn(),
    });
    act(() => {
      result.current.play();
    });
    expect(result.current.isPlaying).toBe(true);

    const painted: LitUpHoldsMap = { ...frameOne, 500: HAND };
    rerender({ frames: [painted, frameTwo], currentFrameIndex: 0, goToFrame: vi.fn() });
    expect(result.current.isPlaying).toBe(false);
  });
});
