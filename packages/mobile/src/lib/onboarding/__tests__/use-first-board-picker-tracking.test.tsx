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
    const { result } = renderHook(() => useFirstBoardPickerTracking('launch_gate'));
    result.current('gym');
    result.current('gym_map');
    expect(trackMock.mock.calls).toEqual([
      [SHARED_EVENTS.FirstBoardPathChosen, { path: 'gym', entry: 'launch_gate' }],
      [SHARED_EVENTS.FirstBoardPathChosen, { path: 'gym_map', entry: 'launch_gate' }],
    ]);
  });

  it('reports a skip when the picker closes with no board bound', async () => {
    const { result, unmount } = renderHook(() => useFirstBoardPickerTracking('launch_gate'));
    result.current('own');
    unmount();

    await waitFor(() => expect(skipEvents()).toHaveLength(1));
    expect(skipEvents()[0][1]).toEqual({ method: 'dismissed', secondsOpen: 0, lastPath: 'own', entry: 'launch_gate' });
  });

  it('names the header X when that is how it closed', async () => {
    const { unmount } = renderHook(() => useFirstBoardPickerTracking('launch_gate'));
    noteFirstBoardCloseTapped();
    unmount();

    await waitFor(() => expect(skipEvents()).toHaveLength(1));
    expect(skipEvents()[0][1]).toMatchObject({ method: 'close_button', lastPath: null });
  });

  // The builder, the gym map and the Bluetooth scan all write the board before
  // they navigate, so any of them reads as a pick, not a skip.
  it('says nothing when a board was bound on the way out', async () => {
    storedBoard.read.mockResolvedValue({ uuid: 'board-1' });
    const { unmount } = renderHook(() => useFirstBoardPickerTracking('launch_gate'));
    unmount();

    await waitFor(() => expect(storedBoard.read).toHaveBeenCalled());
    await Promise.resolve();
    expect(skipEvents()).toEqual([]);
  });

  it('says nothing when the board read fails', async () => {
    storedBoard.read.mockRejectedValue(new Error('read denied'));
    const { unmount } = renderHook(() => useFirstBoardPickerTracking('launch_gate'));
    unmount();

    await waitFor(() => expect(storedBoard.read).toHaveBeenCalled());
    await Promise.resolve();
    expect(skipEvents()).toEqual([]);
  });

  // Climbs' "Pick your board" opens the same block; its showings are told apart
  // so the launch gate's skip rate reads against the gate's own count.
  it('names the Climbs entry on both events', async () => {
    const { result, unmount } = renderHook(() => useFirstBoardPickerTracking('no_board'));
    result.current('scan');
    unmount();

    await waitFor(() => expect(skipEvents()).toHaveLength(1));
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.FirstBoardPathChosen, { path: 'scan', entry: 'no_board' });
    expect(skipEvents()[0][1]).toMatchObject({ entry: 'no_board', lastPath: 'scan' });
  });

  it('reports nothing for the ordinary picker', async () => {
    const { result, unmount } = renderHook(() => useFirstBoardPickerTracking(null));
    result.current('gym');
    unmount();
    await Promise.resolve();
    expect(storedBoard.read).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  // An X note left behind by an earlier picker must not label a later swipe.
  it('drops a stale close note when a new picker opens', async () => {
    noteFirstBoardCloseTapped();
    const { unmount } = renderHook(() => useFirstBoardPickerTracking('launch_gate'));
    unmount();

    await waitFor(() => expect(skipEvents()).toHaveLength(1));
    expect(skipEvents()[0][1]).toMatchObject({ method: 'dismissed' });
  });
});
