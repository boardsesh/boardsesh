// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { BoardName, Climb, PlaybackStateChangedEvent } from '@boardsesh/shared-schema';

// The orchestrator composes three I/O seams — the shared playback engine, the
// queue provider (party-sync), and the optional Bluetooth context (BLE writes).
// We mock all three so the test exercises the orchestrator's own logic: the
// latest-wins GATT-safe drain, the climb-change reset, and party-sync wiring.

type EngineInput = {
  externalState?: { clientId: string | null; frameCount?: number | null; isPlaying?: boolean } | null;
  onLocalStateChange?: (state: {
    frameIndex: number;
    frameCount: number;
    isPlaying: boolean;
    speed: number;
    paceMs: number;
    anchorTimestamp: number;
    clientId: string | null;
  }) => void;
  onPeerFrameMismatch?: (mismatch: { peerFrameCount: number; localFrameCount: number }) => void;
};

type SendCall = { frame: string; mirrored?: boolean; resolve: (value: boolean) => void };

const mocks = vi.hoisted(() => ({
  climbFrames: { frames: [] as unknown[], frameStrings: [] as string[], paceMs: 500 },
  // Mutable engine output — tests drive `currentFrameString` / `isAnimatable`
  // and rerender to fire the BLE effect.
  playback: {
    isAnimatable: true,
    frameCount: 3,
    frameIndex: 0,
    currentFrameString: '',
    isPlaying: false,
    speed: 1,
    peerFrameMismatch: false,
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setSpeed: vi.fn(),
  },
  lastEngineInput: { current: null as EngineInput | null },
  playbackEventListeners: new Set<(event: PlaybackStateChangedEvent) => void>(),
  publishPlaybackState: vi.fn((_input: Record<string, unknown>) => Promise.resolve()),
  // Stable references — the real queue provider memoises these with useCallback.
  // An unstable identity would re-run the subscription effect every render and
  // clear the externally-synced state.
  subscribeToPlaybackEvents: null as unknown as (listener: (event: PlaybackStateChangedEvent) => void) => () => void,
  queueValue: null as unknown as { subscribeToPlaybackEvents: unknown; publishPlaybackState: unknown },
  track: vi.fn(),
  bluetooth: {
    isConnected: true,
    sendFramesToBoard: vi.fn() as ReturnType<typeof vi.fn>,
  },
  sendCalls: [] as SendCall[],
}));

vi.mock('@boardsesh/playback-react', () => ({
  useClimbFrames: () => mocks.climbFrames,
  usePlaybackEngine: (input: EngineInput) => {
    mocks.lastEngineInput.current = input;
    return mocks.playback;
  },
}));

mocks.subscribeToPlaybackEvents = (listener: (event: PlaybackStateChangedEvent) => void) => {
  mocks.playbackEventListeners.add(listener);
  return () => {
    mocks.playbackEventListeners.delete(listener);
  };
};
mocks.queueValue = {
  subscribeToPlaybackEvents: mocks.subscribeToPlaybackEvents,
  publishPlaybackState: mocks.publishPlaybackState,
};

vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => mocks.queueValue,
}));

vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => mocks.bluetooth,
}));

vi.mock('../../../lib/analytics', () => ({
  track: mocks.track,
}));

import { useMobilePlayback } from '../use-mobile-playback';

const KILTER = 'kilter' as BoardName;
const climbWith = (uuid: string) => ({ uuid }) as unknown as Climb;

/** Deliver a playback event to every active playback-event listener. */
function emitPlayback(event: PlaybackStateChangedEvent) {
  act(() => {
    for (const listener of mocks.playbackEventListeners) listener(event);
  });
}

function playbackEvent(overrides: Partial<PlaybackStateChangedEvent> = {}): PlaybackStateChangedEvent {
  return {
    __typename: 'PlaybackStateChanged',
    sequence: 1,
    climbUuid: 'c1',
    frameIndex: 2,
    isPlaying: true,
    speed: 1.5,
    paceMs: 400,
    anchorTimestamp: '1700',
    clientId: 'peer-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.climbFrames = { frames: [], frameStrings: ['F0', 'F1', 'F2'], paceMs: 500 };
  mocks.playback.isAnimatable = true;
  mocks.playback.frameIndex = 0;
  mocks.playback.currentFrameString = '';
  mocks.playback.isPlaying = false;
  mocks.playback.speed = 1;
  mocks.playback.peerFrameMismatch = false;
  mocks.lastEngineInput.current = null;
  mocks.playbackEventListeners.clear();
  mocks.bluetooth.isConnected = true;
  mocks.sendCalls = [];
  // Each write returns a deferred promise so a test can hold a write "in flight".
  mocks.bluetooth.sendFramesToBoard = vi.fn((frame: string, mirrored?: boolean) => {
    return new Promise<boolean>((resolve) => {
      mocks.sendCalls.push({ frame, mirrored, resolve });
    });
  });
});

type PlaybackGates = { viewOnly?: boolean; suppressWallWrites?: boolean };
type PlaybackProps = { climb: Climb | null } & PlaybackGates;

function renderPlayback(climb: Climb | null, gates: PlaybackGates = {}) {
  return renderHook(
    (props: PlaybackProps) =>
      useMobilePlayback({
        climb: props.climb,
        boardName: KILTER,
        mirrored: false,
        isOpen: true,
        viewOnly: props.viewOnly ?? false,
        suppressWallWrites: props.suppressWallWrites ?? false,
      }),
    { initialProps: { climb, ...gates } },
  );
}

/** Push a new current frame and rerender so the BLE effect re-evaluates. */
async function setFrame(
  rerender: (props?: PlaybackProps) => void,
  climb: Climb | null,
  frame: string,
  gates: PlaybackGates = {},
) {
  await act(async () => {
    mocks.playback.currentFrameString = frame;
    rerender({ climb, ...gates });
  });
}

describe('useMobilePlayback — BLE drain', () => {
  // The Browsing chrome promises "the wall stays put": while the drawer shows a
  // preview, playback animates on-screen but not one frame may reach the board.
  it('viewOnly keeps every frame off the wall, then resumes when it lifts', async () => {
    const climb = climbWith('c1');
    const { rerender } = renderPlayback(climb, { viewOnly: true });

    await setFrame(rerender, climb, 'F0', { viewOnly: true });
    await setFrame(rerender, climb, 'F1', { viewOnly: true });
    expect(mocks.bluetooth.sendFramesToBoard).not.toHaveBeenCalled();

    // Preview cleared (Back to live / commit): writes resume with the current frame.
    await act(async () => {
      rerender({ climb, viewOnly: false });
    });
    expect(mocks.bluetooth.sendFramesToBoard).toHaveBeenCalledTimes(1);
    expect(mocks.sendCalls[0].frame).toBe('F1');
    await act(async () => {
      mocks.sendCalls[0].resolve(true);
    });
  });

  // #5099: a climb from another board addresses a DIFFERENT wall's hold ids, so
  // its frames would light the wrong holds on the connected board. The scrim
  // hides the play button, but a party peer's playback event starts the engine
  // with no local tap at all — so the suppression, not the UI, is what has to
  // hold. Peer-driven, connected, engine playing: still nothing on the wall.
  it('keeps a peer-driven animation off the wall while writes are suppressed', async () => {
    const climb = climbWith('c1');
    const { rerender } = renderPlayback(climb, { suppressWallWrites: true });

    await act(async () => {
      emitPlayback(playbackEvent({ climbUuid: 'c1', isPlaying: true }));
    });
    expect(mocks.lastEngineInput.current?.externalState?.isPlaying).toBe(true);

    // The engine advances on the peer's clock; every frame it produces is a
    // write candidate.
    await act(async () => {
      mocks.playback.isPlaying = true;
      mocks.playback.currentFrameString = 'F1';
      rerender({ climb, suppressWallWrites: true });
    });
    await act(async () => {
      mocks.playback.currentFrameString = 'F2';
      rerender({ climb, suppressWallWrites: true });
    });

    expect(mocks.bluetooth.isConnected).toBe(true);
    expect(mocks.bluetooth.sendFramesToBoard).not.toHaveBeenCalled();
  });

  it('collapses overlapping frame writes to the latest (GATT-safe)', async () => {
    const climb = climbWith('c1');
    const { rerender } = renderPlayback(climb);

    // First frame starts a write that stays in flight.
    await setFrame(rerender, climb, 'F0');
    expect(mocks.bluetooth.sendFramesToBoard).toHaveBeenCalledTimes(1);
    expect(mocks.sendCalls[0].frame).toBe('F0');

    // Two more frames arrive before the write resolves: only the newest is kept,
    // and no second write is issued while the first is pending.
    await setFrame(rerender, climb, 'F1');
    await setFrame(rerender, climb, 'F2');
    expect(mocks.bluetooth.sendFramesToBoard).toHaveBeenCalledTimes(1);

    // Resolve the in-flight write; the drain flushes the latest pending frame and
    // skips the superseded one.
    await act(async () => {
      mocks.sendCalls[0].resolve(true);
    });
    expect(mocks.bluetooth.sendFramesToBoard).toHaveBeenCalledTimes(2);
    expect(mocks.sendCalls[1].frame).toBe('F2');
    expect(mocks.bluetooth.sendFramesToBoard.mock.calls.map((call) => call[0])).toEqual(['F0', 'F2']);

    await act(async () => {
      mocks.sendCalls[1].resolve(true);
    });
  });

  it('does not re-send a frame already on the board', async () => {
    const climb = climbWith('c1');
    const { rerender } = renderPlayback(climb);

    await setFrame(rerender, climb, 'F0');
    await act(async () => {
      mocks.sendCalls[0].resolve(true);
    });
    // Same frame string again — nothing to write.
    await setFrame(rerender, climb, 'F0');
    expect(mocks.bluetooth.sendFramesToBoard).toHaveBeenCalledTimes(1);
  });

  it('re-flushes the first frame after a climb change', async () => {
    const c1 = climbWith('c1');
    const { rerender } = renderPlayback(c1);

    await setFrame(rerender, c1, 'F0');
    await act(async () => {
      mocks.sendCalls[0].resolve(true);
    });
    expect(mocks.bluetooth.sendFramesToBoard).toHaveBeenCalledTimes(1);

    // Switch climbs. There's a brief no-frame gap while the next climb's frames
    // load; the climb-change reset clears the write trackers so the new climb's
    // first frame flushes even when it matches the last frame of the old climb.
    const c2 = climbWith('c2');
    await setFrame(rerender, c2, '');
    await setFrame(rerender, c2, 'F0');
    await act(async () => {
      mocks.sendCalls[1]?.resolve(true);
    });
    expect(mocks.bluetooth.sendFramesToBoard).toHaveBeenCalledTimes(2);
    expect(mocks.sendCalls[1].frame).toBe('F0');
  });

  it('writes nothing for boulders (isAnimatable false)', async () => {
    const climb = climbWith('c1');
    mocks.playback.isAnimatable = false;
    const { rerender } = renderPlayback(climb);

    await setFrame(rerender, climb, 'F0');
    expect(mocks.bluetooth.sendFramesToBoard).not.toHaveBeenCalled();
  });

  it('writes nothing while the board is disconnected', async () => {
    const climb = climbWith('c1');
    mocks.bluetooth.isConnected = false;
    const { rerender } = renderPlayback(climb);

    await setFrame(rerender, climb, 'F0');
    expect(mocks.bluetooth.sendFramesToBoard).not.toHaveBeenCalled();
  });

  // The drawer can be BLE-connected, open, and animating a route while what's on
  // screen is a preview — someone else's climb is lit, or the climber is looking
  // ahead in a crew. Every other gate here is satisfied in that state, so this is
  // the one that keeps a scrubbed preview off the wall.
  it('writes nothing while the drawer is showing a preview', async () => {
    const climb = climbWith('c1');
    const { rerender } = renderPlayback(climb, { viewOnly: true });

    await setFrame(rerender, climb, 'F0', { viewOnly: true });
    expect(mocks.bluetooth.sendFramesToBoard).not.toHaveBeenCalled();
  });

  it('flushes the frame once the preview is committed', async () => {
    // Leaving the preview must not leave the wall stuck on the last live frame:
    // the gate suppresses writes, it doesn't poison the write trackers.
    const climb = climbWith('c1');
    const { rerender } = renderPlayback(climb, { viewOnly: true });

    await setFrame(rerender, climb, 'F0', { viewOnly: true });
    expect(mocks.bluetooth.sendFramesToBoard).not.toHaveBeenCalled();

    await setFrame(rerender, climb, 'F0', { viewOnly: false });
    expect(mocks.bluetooth.sendFramesToBoard).toHaveBeenCalledTimes(1);
    expect(mocks.sendCalls[0].frame).toBe('F0');
    await act(async () => {
      mocks.sendCalls[0].resolve(true);
    });
  });
});

describe('useMobilePlayback — party-sync', () => {
  beforeEach(() => {
    // Isolate the subscription wiring from the BLE effect.
    mocks.bluetooth.isConnected = false;
  });

  it('applies a matching peer playback event as external engine state', () => {
    renderPlayback(climbWith('c1'));

    emitPlayback(playbackEvent({ climbUuid: 'c1', clientId: 'peer-1' }));
    expect(mocks.lastEngineInput.current?.externalState?.clientId).toBe('peer-1');
  });

  it('ignores playback events for other climbs', () => {
    renderPlayback(climbWith('c1'));

    emitPlayback(playbackEvent({ climbUuid: 'other-climb' }));
    expect(mocks.lastEngineInput.current?.externalState).toBeNull();
  });

  it('clears peer state when the climb changes', () => {
    const { rerender } = renderPlayback(climbWith('c1'));

    emitPlayback(playbackEvent({ climbUuid: 'c1' }));
    expect(mocks.lastEngineInput.current?.externalState).not.toBeNull();

    act(() => {
      rerender({ climb: climbWith('c2'), viewOnly: false });
    });
    expect(mocks.lastEngineInput.current?.externalState).toBeNull();
  });

  it('publishes local playback state to peers', () => {
    renderPlayback(climbWith('c1'));

    act(() => {
      mocks.lastEngineInput.current?.onLocalStateChange?.({
        frameIndex: 1,
        frameCount: 3,
        isPlaying: true,
        speed: 2,
        paceMs: 500,
        anchorTimestamp: 1700,
        clientId: 'self',
      });
    });

    expect(mocks.publishPlaybackState).toHaveBeenCalledTimes(1);
    const published = mocks.publishPlaybackState.mock.calls[0][0];
    expect(published).toMatchObject({ climbUuid: 'c1', frameIndex: 1, isPlaying: true, speed: 2, paceMs: 500 });
    expect(typeof published.clientId).toBe('string');
  });

  // Issue #3989: the broadcast carries how many frames OUR reader produced, so a
  // peer on a different frames reader can tell its index means something else
  // rather than clamping it into range and freezing on the last frame.
  it('publishes the frame count the engine reports', () => {
    renderPlayback(climbWith('c1'));

    act(() => {
      mocks.lastEngineInput.current?.onLocalStateChange?.({
        frameIndex: 4,
        frameCount: 21,
        isPlaying: true,
        speed: 1,
        paceMs: 500,
        anchorTimestamp: 1700,
        clientId: 'self',
      });
    });

    expect(mocks.publishPlaybackState.mock.calls[0][0]).toMatchObject({ frameCount: 21 });
  });

  it('passes a peer frame count through to the engine, and null when absent', () => {
    const { rerender } = renderPlayback(climbWith('c1'));

    emitPlayback(playbackEvent({ climbUuid: 'c1', frameCount: 21 }));
    expect(mocks.lastEngineInput.current?.externalState?.frameCount).toBe(21);

    // A publisher older than the field sends nothing; the engine must see null
    // rather than a stale count from the previous event.
    act(() => {
      rerender({ climb: climbWith('c1'), viewOnly: false });
    });
    emitPlayback(playbackEvent({ climbUuid: 'c1', frameCount: undefined }));
    expect(mocks.lastEngineInput.current?.externalState?.frameCount).toBeNull();
  });

  // Browsing emits NOTHING on the wire. A published playback state is a write
  // every peer on that climb follows — the wall one hop further out — so a
  // preview being scrubbed must not reach the session at all.
  it('publishes nothing while the drawer is showing a preview', () => {
    renderPlayback(climbWith('c1'), { viewOnly: true });

    act(() => {
      mocks.lastEngineInput.current?.onLocalStateChange?.({
        frameIndex: 1,
        frameCount: 3,
        isPlaying: true,
        speed: 1,
        paceMs: 500,
        anchorTimestamp: 1700,
        clientId: 'self',
      });
    });

    expect(mocks.publishPlaybackState).not.toHaveBeenCalled();
  });

  // Watching what the crew is doing is exactly what browsing IS, so the inbound
  // half stays armed — only the outbound half is gated.
  it('still follows a peer while showing a preview', () => {
    renderPlayback(climbWith('c1'), { viewOnly: true });

    emitPlayback(playbackEvent({ climbUuid: 'c1', clientId: 'peer-1' }));
    expect(mocks.lastEngineInput.current?.externalState?.clientId).toBe('peer-1');
  });

  it('reports a peer frame-count disagreement to analytics', () => {
    renderPlayback(climbWith('c1'));

    act(() => {
      mocks.lastEngineInput.current?.onPeerFrameMismatch?.({ peerFrameCount: 21, localFrameCount: 11 });
    });

    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenLastCalledWith('Playback Peer Frame Mismatch', {
      peerFrameCount: 21,
      localFrameCount: 11,
      boardName: KILTER,
    });
  });
});
