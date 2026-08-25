// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type Climb = {
  climbUuid: string;
  seq: number;
  name: string;
  frames: string;
  angle: number;
  sentAt: string;
  sentByDisplayName?: string;
};

const h = vi.hoisted(() => {
  const mk = (uuid: string, seq: number, over: Partial<Climb> = {}): Climb => ({
    climbUuid: uuid,
    seq,
    name: uuid.toUpperCase(),
    frames: 'p1r15',
    angle: 40,
    sentAt: '2026-07-04T19:42:00.000Z',
    ...over,
  });
  return {
    mk,
    current: null as Climb | null,
    liveHistory: [] as Climb[],
    olderHistory: [] as Climb[],
    hasMore: false,
    isLoadingOlder: false,
    loadOlder: vi.fn(),
    refresh: vi.fn(),
    // The kiosk gates on `canDriveWall` (either transport), not on the BLE link:
    // a wall with no light kit is driven by a virtual hold that writes no bytes.
    canDriveWall: true,
    ledless: false,
    relight: vi.fn(async (_climb: Climb): Promise<boolean> => true),
  };
});

vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceCurrent: () => ({ currentClimb: h.current }),
  useBoardPresenceFeed: () => ({ history: h.liveHistory, stats: null }),
  useBoardHistoryPagination: () => ({
    olderHistory: h.olderHistory,
    isLoadingOlder: h.isLoadingOlder,
    hasMore: h.hasMore,
    loadOlder: h.loadOlder,
  }),
  useBoardPresenceActions: () => ({ refresh: h.refresh }),
  boardHistoryEntryKey: (climb: Climb) => `${climb.climbUuid}:${climb.seq}`,
}));
vi.mock('../../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({ relightPresenceClimb: h.relight }),
}));
vi.mock('../../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    canDriveWall: h.canDriveWall,
    ledless: h.ledless,
  }),
}));

import { useWallPreview } from '../useWallPreview';

describe('useWallPreview', () => {
  beforeEach(() => {
    h.current = h.mk('c3', 3);
    h.liveHistory = [h.mk('c3', 3), h.mk('c2', 2), h.mk('c1', 1)];
    h.olderHistory = [];
    h.hasMore = false;
    h.isLoadingOlder = false;
    h.canDriveWall = true;
    h.ledless = false;
    h.loadOlder.mockClear();
    h.relight.mockClear();
    h.relight.mockImplementation(async () => true);
  });

  it('shows the live climb and no preview by default', () => {
    const { result } = renderHook(() => useWallPreview());
    expect(result.current.isPreviewing).toBe(false);
    expect(result.current.displayedClimb?.climbUuid).toBe('c3');
    expect(result.current.stepsBack).toBe(0);
  });

  it('steps back into a preview of the previous entry', () => {
    const { result } = renderHook(() => useWallPreview());
    act(() => result.current.step('older'));
    expect(result.current.isPreviewing).toBe(true);
    expect(result.current.previewClimb?.climbUuid).toBe('c2');
    expect(result.current.stepsBack).toBe(1);
  });

  it('keeps the preview pinned to (climbUuid, seq) when a live climb prepends', () => {
    const { result, rerender } = renderHook(() => useWallPreview());
    act(() => result.current.step('older')); // previewing c2
    expect(result.current.previewClimb?.climbUuid).toBe('c2');

    // A new climb lights on the wall — indices shift, the key must not.
    act(() => {
      h.current = h.mk('c4', 4);
      h.liveHistory = [h.mk('c4', 4), ...h.liveHistory];
    });
    rerender();

    expect(result.current.isPreviewing).toBe(true);
    expect(result.current.previewClimb?.climbUuid).toBe('c2');
    // Now two entries back from the new head.
    expect(result.current.stepsBack).toBe(2);
  });

  it('returns to live when stepping newer onto the head (never parks on the live climb)', () => {
    const { result } = renderHook(() => useWallPreview());
    act(() => result.current.step('older')); // c2
    act(() => result.current.step('newer')); // back to head → live
    expect(result.current.isPreviewing).toBe(false);
    expect(result.current.displayedClimb?.climbUuid).toBe('c3');
  });

  it('auto-exits to live only when the newly-lit climb IS the previewed one (by UUID)', () => {
    const { result, rerender } = renderHook(() => useWallPreview());
    act(() => result.current.step('older')); // previewing c2

    // A different climb lights → stay in preview.
    act(() => {
      h.current = h.mk('c9', 9);
      h.liveHistory = [h.mk('c9', 9), ...h.liveHistory];
    });
    rerender();
    expect(result.current.isPreviewing).toBe(true);
    expect(result.current.previewClimb?.climbUuid).toBe('c2');

    // The previewed climb (c2) is re-lit — a fresh seq, same UUID → snap to live.
    act(() => {
      h.current = h.mk('c2', 10);
      h.liveHistory = [h.mk('c2', 10), ...h.liveHistory];
    });
    rerender();
    expect(result.current.isPreviewing).toBe(false);
    expect(result.current.displayedClimb?.climbUuid).toBe('c2');
  });

  it('lights the previewed climb, stays pinned until the echo, then follows live', async () => {
    const { result, rerender } = renderHook(() => useWallPreview());
    act(() => result.current.step('older')); // c2
    expect(result.current.canLight).toBe(true);
    expect(result.current.lightBlockedReason).toBeNull();

    await act(async () => {
      result.current.lightThis();
    });
    expect(h.relight).toHaveBeenCalledTimes(1);
    expect(h.relight.mock.calls[0]?.[0]?.climbUuid).toBe('c2');
    // Stays pinned to the just-lit climb (currentClimb hasn't caught up), so the
    // hero shows the RIGHT climb rather than snapping to the stale old live one.
    expect(result.current.isPreviewing).toBe(true);
    expect(result.current.displayedClimb?.climbUuid).toBe('c2');

    // The presence push echoes the relit climb (same uuid, fresh seq) → back to live.
    act(() => {
      h.current = h.mk('c2', 10);
      h.liveHistory = [h.mk('c2', 10), ...h.liveHistory];
    });
    rerender();
    expect(result.current.isPreviewing).toBe(false);
  });

  it('reaches (and lights) the just-cleared climb when the wall is dark', () => {
    // Wall cleared: currentClimb null, history retained. The newest entry must be
    // the FIRST step-back target and not skipped (the wrong-climb bug).
    h.current = null;
    const { result } = renderHook(() => useWallPreview());
    expect(result.current.isPreviewing).toBe(false); // idle
    expect(result.current.canStepOlder).toBe(true);

    act(() => result.current.step('older'));
    expect(result.current.previewClimb?.climbUuid).toBe('c3'); // the just-cleared climb, NOT c2
    expect(result.current.stepsBack).toBe(1);

    // Stepping newer from the newest entry returns to the dark live wall.
    act(() => result.current.step('newer'));
    expect(result.current.isPreviewing).toBe(false);
  });

  it('computes canStepOlder/canStepNewer correctly at live and at the oldest entry', () => {
    const { result } = renderHook(() => useWallPreview());
    // Live at the head: can go older (history below), cannot go newer.
    expect(result.current.canStepOlder).toBe(true);
    expect(result.current.canStepNewer).toBe(false);
    // Scrub to the oldest loaded entry (c1); no more pages → older is now false.
    act(() => result.current.goOldest());
    expect(result.current.previewClimb?.climbUuid).toBe('c1');
    expect(result.current.canStepOlder).toBe(false);
    expect(result.current.canStepNewer).toBe(true);
  });

  it('blocks Light-this when this iPad is not the driver', () => {
    h.canDriveWall = false;
    const { result } = renderHook(() => useWallPreview());
    act(() => result.current.step('older'));
    expect(result.current.canLight).toBe(false);
    expect(result.current.lightBlockedReason).toBe('not-driver');
  });

  it('offers take-the-wall, not connect-Bluetooth, on a wall with no light kit', () => {
    // The whole point of #4585: there is no LED box to connect to, so prompting
    // for Bluetooth is a dead end. The scrubber must offer the wall instead.
    h.ledless = true;
    h.canDriveWall = false;
    const { result } = renderHook(() => useWallPreview());
    act(() => result.current.step('older'));
    expect(result.current.canLight).toBe(false);
    expect(result.current.lightBlockedReason).toBe('no-leds-not-held');
  });

  it('lets a ledless iPad put a climb up once it holds the wall virtually', () => {
    h.ledless = true;
    h.canDriveWall = true;
    const { result } = renderHook(() => useWallPreview());
    act(() => result.current.step('older'));
    expect(result.current.lightBlockedReason).toBeNull();
    expect(result.current.canLight).toBe(true);
  });

  it('relights through the shared commit seam while holding the wall with no Bluetooth', async () => {
    h.ledless = true;
    h.canDriveWall = true;
    const { result } = renderHook(() => useWallPreview());
    act(() => result.current.step('older'));
    await act(async () => {
      result.current.lightThis();
    });
    expect(h.relight).toHaveBeenCalledTimes(1);
    expect(h.relight.mock.calls[0]?.[0]?.climbUuid).toBe('c2');
  });

  it('keeps the no-lights offer ahead of a frameless entry', () => {
    // Precedence guard: an unheld ledless wall must not ask the user to fix a
    // missing-frames problem they cannot act on until they hold the wall.
    h.ledless = true;
    h.canDriveWall = false;
    h.liveHistory = [h.mk('c3', 3), h.mk('c2', 2, { frames: '' }), h.mk('c1', 1)];
    const { result } = renderHook(() => useWallPreview());
    act(() => result.current.step('older'));
    expect(result.current.lightBlockedReason).toBe('no-leds-not-held');
  });

  it('lets a mis-flagged but connected board light the wall, not take it', () => {
    // A board wrongly flagged as having no lights can still hold a live link —
    // the creator header's Bluetooth toggle, an iOS reconnect intent. Offering
    // "take the wall" there is a dead button: takeVirtualWall refuses while
    // connected. Connected wins, matching derivePlayDrawerLightbulbPressAction.
    h.ledless = true;
    h.canDriveWall = true;
    h.liveHistory = [h.mk('c3', 3), h.mk('c2', 2), h.mk('c1', 1)];
    const { result } = renderHook(() => useWallPreview());
    act(() => result.current.step('older'));
    expect(result.current.lightBlockedReason).toBeNull();
    expect(result.current.canLight).toBe(true);
  });

  it('blocks Light-this when the previewed climb has no saved holds', () => {
    h.liveHistory = [h.mk('c3', 3), h.mk('c2', 2, { frames: '' }), h.mk('c1', 1)];
    const { result } = renderHook(() => useWallPreview());
    act(() => result.current.step('older')); // c2, no frames
    expect(result.current.previewClimb?.climbUuid).toBe('c2');
    expect(result.current.canLight).toBe(false);
    expect(result.current.lightBlockedReason).toBe('no-frames');
  });

  it('requires a second confirm when a newer climb lit after preview began', async () => {
    const { result, rerender } = renderHook(() => useWallPreview());
    act(() => result.current.step('older')); // previewing c2, live head seq 3

    // Someone lights a new climb mid-preview.
    act(() => {
      h.current = h.mk('c8', 8);
      h.liveHistory = [h.mk('c8', 8), ...h.liveHistory];
    });
    rerender();

    // First tap only arms the confirm — no write yet.
    act(() => result.current.lightThis());
    expect(result.current.pendingOverride).toBe(true);
    expect(h.relight).not.toHaveBeenCalled();

    // Confirming writes.
    await act(async () => {
      result.current.confirmOverride();
    });
    expect(h.relight).toHaveBeenCalledTimes(1);
    expect(h.relight.mock.calls[0]?.[0]?.climbUuid).toBe('c2');
  });
});
