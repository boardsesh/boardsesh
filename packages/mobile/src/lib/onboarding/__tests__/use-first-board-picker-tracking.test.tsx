// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SHARED_EVENTS } from '@boardsesh/analytics';

const trackMock = vi.hoisted(() => vi.fn());
const storedBoard = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('../../analytics', () => ({ track: trackMock }));
vi.mock('../../active-board-store', () => ({ getStoredActiveBoard: storedBoard.read }));

const { useFirstBoardPickerTracking } = await import('../use-first-board-picker-tracking');
const { noteFirstBoardCloseTapped } = await import('../first-board-picker-analytics');

function skipEvents() {
  return trackMock.mock.calls.filter(([name]) => name === SHARED_EVENTS.FirstBoardPickerSkipped);
}

describe('useFirstBoardPickerTracking', () => {
  beforeEach(() => {
    trackMock.mockClear();
    storedBoard.read.mockReset();
    storedBoard.read.mockResolvedValue(null);
  });

  it('reports each choice tapped', () => {
    const { result } = renderHook(() => useFirstBoardPickerTracking(true));
    result.current('gym');
    result.current('gym_map');
    expect(trackMock.mock.calls).toEqual([
      [SHARED_EVENTS.FirstBoardPathChosen, { path: 'gym' }],
      [SHARED_EVENTS.FirstBoardPathChosen, { path: 'gym_map' }],
    ]);
  });

  it('reports a skip when the picker closes with no board bound', async () => {
    const { result, unmount } = renderHook(() => useFirstBoardPickerTracking(true));
    result.current('own');
    unmount();

    await waitFor(() => expect(skipEvents()).toHaveLength(1));
    expect(skipEvents()[0][1]).toEqual({ method: 'dismissed', secondsOpen: 0, lastPath: 'own' });
  });

  it('names the header X when that is how it closed', async () => {
    const { unmount } = renderHook(() => useFirstBoardPickerTracking(true));
    noteFirstBoardCloseTapped();
    unmount();

    await waitFor(() => expect(skipEvents()).toHaveLength(1));
    expect(skipEvents()[0][1]).toMatchObject({ method: 'close_button', lastPath: null });
  });

  // The builder, the gym map and the Bluetooth scan all write the board before
  // they navigate, so any of them reads as a pick, not a skip.
  it('says nothing when a board was bound on the way out', async () => {
    storedBoard.read.mockResolvedValue({ uuid: 'board-1' });
    const { unmount } = renderHook(() => useFirstBoardPickerTracking(true));
    unmount();

    await waitFor(() => expect(storedBoard.read).toHaveBeenCalled());
    await Promise.resolve();
    expect(skipEvents()).toEqual([]);
  });

  it('says nothing when the board read fails', async () => {
    storedBoard.read.mockRejectedValue(new Error('read denied'));
    const { unmount } = renderHook(() => useFirstBoardPickerTracking(true));
    unmount();

    await waitFor(() => expect(storedBoard.read).toHaveBeenCalled());
    await Promise.resolve();
    expect(skipEvents()).toEqual([]);
  });

  it('reports nothing for the ordinary picker', async () => {
    const { unmount } = renderHook(() => useFirstBoardPickerTracking(false));
    unmount();
    await Promise.resolve();
    expect(storedBoard.read).not.toHaveBeenCalled();
    expect(skipEvents()).toEqual([]);
  });

  // An X note left behind by an earlier picker must not label a later swipe.
  it('drops a stale close note when a new picker opens', async () => {
    noteFirstBoardCloseTapped();
    const { unmount } = renderHook(() => useFirstBoardPickerTracking(true));
    unmount();

    await waitFor(() => expect(skipEvents()).toHaveLength(1));
    expect(skipEvents()[0][1]).toMatchObject({ method: 'dismissed' });
  });
});
