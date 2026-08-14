import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';
import { usePlaybackEngine, type ExternalPlaybackState } from '../use-playback-engine';

const TENSION_FRAMES = 'p100r1,p200r2,p300r3,p400r3';

function decode(frames: string) {
  const split = frames.split(',').filter(Boolean);
  const decoded = convertLitUpHoldsStringToMap(frames, 'tension');
  return {
    frameStrings: split,
    frames: split.map((_, i) => decoded[i] ?? {}),
  };
}

describe('usePlaybackEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no-ops on a single-frame climb', () => {
    const { frames, frameStrings } = decode('p100r1');
    const { result } = renderHook(() => usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'a' }));
    expect(result.current.isAnimatable).toBe(false);
    expect(result.current.frameIndex).toBe(0);
    act(() => {
      result.current.play();
    });
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentFrameString).toBe('p100r1');
  });

  it('advances one frame per pace tick when playing', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const { result } = renderHook(() => usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'a' }));
    expect(result.current.isAnimatable).toBe(true);
    expect(result.current.frameIndex).toBe(0);
    act(() => {
      result.current.play();
    });
    expect(result.current.isPlaying).toBe(true);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.frameIndex).toBe(1);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.frameIndex).toBe(2);
  });

  it('stops at the last frame instead of looping', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const { result } = renderHook(() => usePlaybackEngine({ frames, frameStrings, paceMs: 300, clientId: 'a' }));
    act(() => {
      result.current.play();
    });
    act(() => {
      // Advance well past the end; the engine should rest on the last frame.
      vi.advanceTimersByTime(300 * (frameStrings.length + 2));
    });
    expect(result.current.frameIndex).toBe(frameStrings.length - 1);
    expect(result.current.isPlaying).toBe(false);
  });

  it('restarts from frame 0 when play is pressed on the last frame', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const { result } = renderHook(() => usePlaybackEngine({ frames, frameStrings, paceMs: 300, clientId: 'a' }));
    act(() => {
      result.current.play();
    });
    act(() => {
      vi.advanceTimersByTime(300 * (frameStrings.length + 2));
    });
    expect(result.current.frameIndex).toBe(frameStrings.length - 1);
    act(() => {
      result.current.play();
    });
    expect(result.current.frameIndex).toBe(0);
    expect(result.current.isPlaying).toBe(true);
  });

  it('halves tick interval at speed=2', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    // paceMs / speed = 800 / 2 = 400ms, comfortably above the 200ms MIN_PACE_MS floor.
    const { result } = renderHook(() => usePlaybackEngine({ frames, frameStrings, paceMs: 800, clientId: 'a' }));
    act(() => {
      result.current.setSpeed(2);
      result.current.play();
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.frameIndex).toBe(1);
  });

  it('seek clamps to valid range and updates the frame string', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const { result } = renderHook(() => usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'a' }));
    act(() => {
      result.current.seek(99);
    });
    expect(result.current.frameIndex).toBe(frameStrings.length - 1);
    expect(result.current.currentFrameString).toBe(frameStrings[frameStrings.length - 1]);
    act(() => {
      result.current.seek(-5);
    });
    expect(result.current.frameIndex).toBe(0);
  });

  it('converges to external (peer) state and ignores echoes', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const { result, rerender } = renderHook(
      ({ externalState }: { externalState: ExternalPlaybackState | null }) =>
        usePlaybackEngine({
          frames,
          frameStrings,
          paceMs: 200,
          clientId: 'self',
          externalState,
        }),
      { initialProps: { externalState: null as ExternalPlaybackState | null } },
    );

    // Peer broadcasts frame 2, paused, at the current time.
    rerender({
      externalState: {
        frameIndex: 2,
        isPlaying: false,
        speed: 1,
        paceMs: 200,
        anchorTimestamp: Date.now(),
        clientId: 'peer',
      },
    });
    expect(result.current.frameIndex).toBe(2);
    expect(result.current.isPlaying).toBe(false);

    // Echo of our own state should not retrigger convergence — pin the
    // engine at frame 1 then send an echo at frame 0.
    act(() => {
      result.current.seek(1);
    });
    rerender({
      externalState: {
        frameIndex: 0,
        isPlaying: false,
        speed: 1,
        paceMs: 200,
        anchorTimestamp: Date.now(),
        clientId: 'self',
      },
    });
    expect(result.current.frameIndex).toBe(1);
  });

  it('extrapolates frames from peer anchor when isPlaying', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const now = Date.now();
    vi.setSystemTime(now);
    const external: ExternalPlaybackState = {
      frameIndex: 0,
      isPlaying: true,
      speed: 1,
      paceMs: 200,
      anchorTimestamp: now - 410, // ~2 frames worth of elapsed time
      clientId: 'peer',
    };
    const { result } = renderHook(() =>
      usePlaybackEngine({
        frames,
        frameStrings,
        paceMs: 200,
        clientId: 'self',
        externalState: external,
      }),
    );
    expect(result.current.frameIndex).toBe(2);
  });

  it('clamps NaN speed in external state to 1', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const external: ExternalPlaybackState = {
      frameIndex: 1,
      isPlaying: false,
      speed: Number.NaN,
      paceMs: 200,
      anchorTimestamp: Date.now(),
      clientId: 'peer',
    };
    const { result } = renderHook(() =>
      usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'self', externalState: external }),
    );
    // NaN speed is rejected → default to 1; frame 1 is preserved (paused so no extrapolation).
    expect(result.current.speed).toBe(1);
    expect(result.current.frameIndex).toBe(1);
  });

  it('clamps negative frameIndex in external state to 0', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const external: ExternalPlaybackState = {
      frameIndex: -5,
      isPlaying: false,
      speed: 1,
      paceMs: 200,
      anchorTimestamp: Date.now(),
      clientId: 'peer',
    };
    const { result } = renderHook(() =>
      usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'self', externalState: external }),
    );
    expect(result.current.frameIndex).toBe(0);
  });

  it('clamps paceMs=0 in external state so extrapolation does not divide by zero', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const now = Date.now();
    vi.setSystemTime(now);
    const external: ExternalPlaybackState = {
      frameIndex: 0,
      isPlaying: true,
      speed: 1,
      paceMs: 0,
      anchorTimestamp: now - 1000,
      clientId: 'peer',
    };
    const { result } = renderHook(() =>
      usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'self', externalState: external }),
    );
    // paceMs=0 clamped to MIN_PACE_MS (200) → 1000ms / 200ms = 5 steps.
    // Playback no longer loops, so the projection clamps to the last frame
    // and the engine reports stopped. No divide-by-zero, no Infinity.
    expect(Number.isFinite(result.current.frameIndex)).toBe(true);
    expect(result.current.frameIndex).toBe(frameStrings.length - 1);
    expect(result.current.isPlaying).toBe(false);
  });

  it('emits onLocalStateChange on user actions but not on auto ticks', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const onLocalStateChange = vi.fn();
    const { result } = renderHook(() =>
      usePlaybackEngine({
        frames,
        frameStrings,
        paceMs: 200,
        clientId: 'self',
        onLocalStateChange,
      }),
    );
    act(() => {
      result.current.play();
    });
    expect(onLocalStateChange).toHaveBeenCalledTimes(1);
    onLocalStateChange.mockClear();
    act(() => {
      vi.advanceTimersByTime(600); // three ticks
    });
    expect(onLocalStateChange).not.toHaveBeenCalled();
    act(() => {
      result.current.pause();
    });
    expect(onLocalStateChange).toHaveBeenCalledTimes(1);
    onLocalStateChange.mockClear();
    act(() => {
      result.current.seek(1);
    });
    expect(onLocalStateChange).toHaveBeenCalledTimes(1);
    onLocalStateChange.mockClear();
    act(() => {
      result.current.setSpeed(2);
    });
    expect(onLocalStateChange).toHaveBeenCalledTimes(1);
  });

  it('broadcasts the stop when playback reaches the last frame', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const onLocalStateChange = vi.fn();
    const { result } = renderHook(() =>
      usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'self', onLocalStateChange }),
    );
    act(() => {
      result.current.play();
    });
    onLocalStateChange.mockClear();
    act(() => {
      // Run through every frame; the terminal tick stops and broadcasts.
      vi.advanceTimersByTime(200 * (frameStrings.length + 1));
    });
    expect(onLocalStateChange).toHaveBeenCalledTimes(1);
    expect(onLocalStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ isPlaying: false, frameIndex: frameStrings.length - 1 }),
    );
    expect(result.current.frameIndex).toBe(frameStrings.length - 1);
    expect(result.current.isPlaying).toBe(false);
  });
});

// Issue #3989: the broadcast used to carry a bare frameIndex, so a peer running
// a different frames reader (mid-rollout: web deploys instantly, mobile arrives
// by OTA over days) sent indexes into a sequence we don't have. The old
// behaviour clamped that index into our range, which made `reachedEnd` trivially
// true and parked the board on its last frame for the rest of the climb.
describe('usePlaybackEngine peer frame-count disagreement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function peerState(overrides: Partial<ExternalPlaybackState> = {}): ExternalPlaybackState {
    return {
      frameIndex: 0,
      isPlaying: false,
      speed: 1,
      paceMs: 200,
      anchorTimestamp: Date.now(),
      clientId: 'peer',
      ...overrides,
    };
  }

  it('ignores a peer whose frame count is larger than ours instead of clamping and stopping', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const onPeerFrameMismatch = vi.fn();
    const { result, rerender } = renderHook(
      ({ externalState }: { externalState: ExternalPlaybackState | null }) =>
        usePlaybackEngine({
          frames,
          frameStrings,
          paceMs: 200,
          clientId: 'self',
          externalState,
          onPeerFrameMismatch,
        }),
      { initialProps: { externalState: null as ExternalPlaybackState | null } },
    );

    // Local playback is under way at frame 1.
    act(() => {
      result.current.play();
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.frameIndex).toBe(1);

    // A peer on a newer reader broadcasts an index from a 21-frame sequence.
    rerender({
      externalState: peerState({ frameIndex: 15, isPlaying: true, frameCount: 21 }),
    });

    // Not clamped to the last frame, not stopped, not reset to 0 — we keep
    // playing our own sequence and simply stop following the peer.
    expect(result.current.frameIndex).toBe(1);
    expect(result.current.isPlaying).toBe(true);
    expect(result.current.peerFrameMismatch).toBe(true);
    expect(onPeerFrameMismatch).toHaveBeenCalledTimes(1);
    expect(onPeerFrameMismatch).toHaveBeenLastCalledWith({ peerFrameCount: 21, localFrameCount: 4 });
  });

  it('ignores a peer whose frame count is smaller than ours', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const { result, rerender } = renderHook(
      ({ externalState }: { externalState: ExternalPlaybackState | null }) =>
        usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'self', externalState }),
      { initialProps: { externalState: null as ExternalPlaybackState | null } },
    );
    act(() => {
      result.current.seek(3);
    });
    rerender({ externalState: peerState({ frameIndex: 0, isPlaying: true, frameCount: 2 }) });
    expect(result.current.frameIndex).toBe(3);
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.peerFrameMismatch).toBe(true);
  });

  it('fires the mismatch callback once per stretch of disagreement, not per event', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const onPeerFrameMismatch = vi.fn();
    const { rerender } = renderHook(
      ({ externalState }: { externalState: ExternalPlaybackState | null }) =>
        usePlaybackEngine({
          frames,
          frameStrings,
          paceMs: 200,
          clientId: 'self',
          externalState,
          onPeerFrameMismatch,
        }),
      { initialProps: { externalState: null as ExternalPlaybackState | null } },
    );
    // A peer scrubbing a slider republishes constantly; only the first one
    // should reach the telemetry seam.
    for (const frameIndex of [4, 5, 6]) {
      rerender({ externalState: peerState({ frameIndex, frameCount: 9 }) });
    }
    expect(onPeerFrameMismatch).toHaveBeenCalledTimes(1);
  });

  it('converges normally when the peer reports the same frame count', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const onPeerFrameMismatch = vi.fn();
    const { result, rerender } = renderHook(
      ({ externalState }: { externalState: ExternalPlaybackState | null }) =>
        usePlaybackEngine({
          frames,
          frameStrings,
          paceMs: 200,
          clientId: 'self',
          externalState,
          onPeerFrameMismatch,
        }),
      { initialProps: { externalState: null as ExternalPlaybackState | null } },
    );
    rerender({
      externalState: peerState({ frameIndex: 2, speed: 2, frameCount: frameStrings.length }),
    });
    expect(result.current.frameIndex).toBe(2);
    expect(result.current.speed).toBe(2);
    expect(result.current.peerFrameMismatch).toBe(false);
    expect(onPeerFrameMismatch).not.toHaveBeenCalled();
  });

  it('keeps the legacy clamp for peers that send no frame count', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const now = Date.now();
    vi.setSystemTime(now);
    const { result } = renderHook(() =>
      usePlaybackEngine({
        frames,
        frameStrings,
        paceMs: 200,
        clientId: 'self',
        externalState: peerState({ frameIndex: 99, isPlaying: true, anchorTimestamp: now }),
      }),
    );
    // Unchanged pre-#3989 behaviour: an out-of-range index from a client that
    // predates the field clamps to the last frame and stops.
    expect(result.current.frameIndex).toBe(frameStrings.length - 1);
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.peerFrameMismatch).toBe(false);
  });

  it('clears the mismatch once a peer agrees again, and on climb change', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const other = decode('p100r1,p200r2');
    const { result, rerender } = renderHook(
      ({ externalState, climb }: { externalState: ExternalPlaybackState | null; climb: ReturnType<typeof decode> }) =>
        usePlaybackEngine({
          frames: climb.frames,
          frameStrings: climb.frameStrings,
          paceMs: 200,
          clientId: 'self',
          externalState,
        }),
      { initialProps: { externalState: null as ExternalPlaybackState | null, climb: { frames, frameStrings } } },
    );
    rerender({ externalState: peerState({ frameCount: 12 }), climb: { frames, frameStrings } });
    expect(result.current.peerFrameMismatch).toBe(true);

    // Peer updated (or a different peer takes over) and now agrees.
    rerender({
      externalState: peerState({ frameIndex: 1, frameCount: frameStrings.length }),
      climb: { frames, frameStrings },
    });
    expect(result.current.peerFrameMismatch).toBe(false);
    expect(result.current.frameIndex).toBe(1);

    // Back to a disagreement, then swap the climb underneath. Hosts drop the
    // peer state on climb change (both use-mobile-playback and
    // use-drawer-playback do), and the flag is per-climb, so it clears.
    rerender({ externalState: peerState({ frameCount: 12 }), climb: { frames, frameStrings } });
    expect(result.current.peerFrameMismatch).toBe(true);
    rerender({ externalState: null, climb: other });
    expect(result.current.peerFrameMismatch).toBe(false);
  });

  it('clears the mismatch when the host drops the peer state', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const { result, rerender } = renderHook(
      ({ externalState }: { externalState: ExternalPlaybackState | null }) =>
        usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'self', externalState }),
      { initialProps: { externalState: null as ExternalPlaybackState | null } },
    );
    rerender({ externalState: peerState({ frameCount: 12 }) });
    expect(result.current.peerFrameMismatch).toBe(true);

    // The mismatched peer left the session, so the host clears its state. The
    // notice must not outlive the peer it describes.
    rerender({ externalState: null });
    expect(result.current.peerFrameMismatch).toBe(false);
  });

  it('stamps our own frame count on every emitted state', () => {
    const { frames, frameStrings } = decode(TENSION_FRAMES);
    const onLocalStateChange = vi.fn();
    const { result } = renderHook(() =>
      usePlaybackEngine({ frames, frameStrings, paceMs: 200, clientId: 'self', onLocalStateChange }),
    );
    act(() => {
      result.current.play();
    });
    expect(onLocalStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ frameCount: frameStrings.length }));
    act(() => {
      result.current.setSpeed(2);
    });
    expect(onLocalStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ frameCount: frameStrings.length }));
  });

  it('emits nothing for a frameless climb, so frameCount is never 0', () => {
    const onLocalStateChange = vi.fn();
    const { result } = renderHook(() =>
      usePlaybackEngine({ frames: [], frameStrings: [], paceMs: 200, clientId: 'self', onLocalStateChange }),
    );
    // setSpeed is the one control not gated on isAnimatable.
    act(() => {
      result.current.setSpeed(2);
    });
    expect(onLocalStateChange).not.toHaveBeenCalled();
    expect(result.current.speed).toBe(2);
  });
});
