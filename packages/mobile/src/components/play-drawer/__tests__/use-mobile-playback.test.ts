// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Climb, BoardName } from '@boardsesh/shared-schema';

// The orchestrator composes three I/O seams — the shared playback engine, the
// queue provider (party-sync), and the optional Bluetooth context (BLE writes).
// We mock all three so the test exercises the orchestrator's own logic: the
// latest-wins GATT-safe drain, the climb-change reset, and party-sync wiring.

type EngineInput = {
  externalState?: { clientId: string | null } | null;
  onLocalStateChange?: (state: {
    frameIndex: number;
    isPlaying: boolean;
    speed: number;
    paceMs: number;
    anchorTimestamp: number;
    clientId: string | null;
  }) => void;
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
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setSpeed: vi.fn(),
  },
  lastEngineInput: { current: null as EngineInput | null },
  queueListeners: new Set<(event: unknown) => void>(),
  publishPlaybackState: vi.fn((_input: Record<string, unknown>) => Promise.resolve()),
  // Stable references — the real queue provider memoises these with useCallback.
  // An unstable identity would re-run the subscription effect every render and
  // clear the externally-synced state.
  subscribeToQueueEvents: null as unknown as (listener: (event: unknown) => void) => () => void,
  queueValue: null as unknown as { subscribeToQueueEvents: unknown; publishPlaybackState: unknown },
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

mocks.subscribeToQueueEvents = (listener: (event: unknown) => void) => {
  mocks.queueListeners.add(listener);
  return () => {
    mocks.queueListeners.delete(listener);
  };
};
mocks.queueValue = {
  subscribeToQueueEvents: mocks.subscribeToQueueEvents,
  publishPlaybackState: mocks.publishPlaybackState,
};

vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => mocks.queueValue,
}));

vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => mocks.bluetooth,
}));

import { useMobilePlayback } from '../use-mobile-playback';

const KILTER = 'kilter' as BoardName;
const climbWith = (uuid: string) => ({ uuid }) as unknown as Climb;

/** Deliver a fake wire event to every active queue-event listener. */
function emit(event: Record<string, unknown>) {
  act(() => {
    for (const listener of mocks.queueListeners) listener(event);
  });
}

function playbackEvent(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'PlaybackStateChanged',
    climbUuid: 'c1',
    frameIndex: 2,
    isPlaying: true,
    speed: 1.5,
    paceMs: 400,
    anchorTimestamp: 1700,
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
  mocks.lastEngineInput.current = null;
  mocks.queueListeners.clear();
  mocks.bluetooth.isConnected = true;
  mocks.sendCalls = [];
  // Each write returns a deferred promise so a test can hold a write "in flight".
  mocks.bluetooth.sendFramesToBoard = vi.fn((frame: string, mirrored?: boolean) => {
    return new Promise<boolean>((resolve) => {
      mocks.sendCalls.push({ frame, mirrored, resolve });
    });
  });
});

function renderPlayback(climb: Climb | null) {
  return renderHook(
    (props: { climb: Climb | null }) =>
      useMobilePlayback({
        climb: props.climb,
        boardName: KILTER,
        mirrored: false,
        isOpen: true,
      }),
    { initialProps: { climb } },
  );
}

/** Push a new current frame and rerender so the BLE effect re-evaluates. */
async function setFrame(rerender: (props: { climb: Climb | null }) => void, climb: Climb | null, frame: string) {
  await act(async () => {
    mocks.playback.currentFrameString = frame;
    rerender({ climb });
  });
}

describe('useMobilePlayback — BLE drain', () => {
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
});

describe('useMobilePlayback — party-sync', () => {
  beforeEach(() => {
    // Isolate the subscription wiring from the BLE effect.
    mocks.bluetooth.isConnected = false;
  });

  it('applies a matching peer playback event as external engine state', () => {
    renderPlayback(climbWith('c1'));

    emit(playbackEvent({ climbUuid: 'c1', clientId: 'peer-1' }));
    expect(mocks.lastEngineInput.current?.externalState?.clientId).toBe('peer-1');
  });

  it('ignores events for other climbs and non-playback events', () => {
    renderPlayback(climbWith('c1'));

    emit(playbackEvent({ climbUuid: 'other-climb' }));
    emit({ __typename: 'QueueItemAdded' });
    expect(mocks.lastEngineInput.current?.externalState).toBeNull();
  });

  it('clears peer state when the climb changes', () => {
    const { rerender } = renderPlayback(climbWith('c1'));

    emit(playbackEvent({ climbUuid: 'c1' }));
    expect(mocks.lastEngineInput.current?.externalState).not.toBeNull();

    act(() => {
      rerender({ climb: climbWith('c2') });
    });
    expect(mocks.lastEngineInput.current?.externalState).toBeNull();
  });

  it('publishes local playback state to peers', () => {
    renderPlayback(climbWith('c1'));

    act(() => {
      mocks.lastEngineInput.current?.onLocalStateChange?.({
        frameIndex: 1,
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
});
