// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: { enabled: true, controller: { type: 'wled', url: 'http://wall.local' } },
  show: vi.fn(),
  lightAll: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  isOwner: vi.fn(),
  create: vi.fn(),
  background: null as ((next: string) => void) | null,
}));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, callback: (next: string) => void) => {
      mocks.background = callback;
      return { remove: vi.fn() };
    },
  },
}));
vi.mock('../use-spray-wall-led-settings', () => ({
  useSprayWallLedSettings: () => ({ settings: mocks.settings, loading: false }),
}));
vi.mock('@boardsesh/led-controller', async (original) => ({
  ...(await original<object>()),
  getLedControllerDriver: () => ({}),
  createLedPreviewSession: mocks.create,
}));

import { useSprayLedPreview } from '../use-spray-led-preview';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = { enabled: true, controller: { type: 'wled', url: 'http://wall.local' } };
  for (const mock of [mocks.show, mocks.lightAll, mocks.stop, mocks.close]) mock.mockResolvedValue(true);
  mocks.isOwner.mockReturnValue(true);
  mocks.create.mockReturnValue({
    show: mocks.show,
    lightAll: mocks.lightAll,
    stop: mocks.stop,
    close: mocks.close,
    isOwner: mocks.isOwner,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('spray LED preview lifecycle', () => {
  it('waits for interaction and keeps callbacks stable through state changes', async () => {
    const { result, rerender, unmount } = renderHook(() => useSprayLedPreview('wall'));
    expect(result.current.available).toBe(true);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    const show = result.current.show;
    await act(() => show([4, 8]));
    expect(result.current.state).toBe('lit');
    rerender();
    expect(result.current.show).toBe(show);
    unmount();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('closes the old session on disable and controller changes', async () => {
    const { result, rerender } = renderHook(() => useSprayLedPreview('wall'));
    await act(() => result.current.show([2]));
    mocks.settings = { ...mocks.settings, enabled: false };
    rerender();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(result.current.available).toBe(false);
    await act(() => result.current.show([3]));
    expect(mocks.show).toHaveBeenCalledTimes(1);
    mocks.settings = { enabled: true, controller: { type: 'wled', url: 'http://new.local' } };
    rerender();
    expect(mocks.create).toHaveBeenLastCalledWith({}, 'http://new.local');
  });

  it('chases in supplied order, at 100ms intervals, then clears', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSprayLedPreview('wall'));
    let completion!: Promise<boolean>;
    await act(async () => {
      completion = result.current.chase([7, 2, 9]);
    });
    expect(result.current.state).toBe('chasing');
    expect(mocks.show.mock.calls).toEqual([[[7]]]);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(await completion).toBe(true);
    expect(mocks.show.mock.calls).toEqual([[[7]], [[2]], [[9]]]);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('idle');
  });

  it('stop cancels the chase without advancing another LED', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSprayLedPreview('wall'));
    await act(async () => {
      void result.current.chase([7, 2, 9]);
    });
    await act(() => result.current.stop());
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('idle');
  });

  it('another preview owner interrupts a chase without stealing control back', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSprayLedPreview('wall'));
    await act(async () => {
      void result.current.chase([7, 2]);
    });
    mocks.isOwner.mockReturnValue(false);
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });

  it('backgrounding clears owned illumination and cancels future chase ticks', async () => {
    const { result } = renderHook(() => useSprayLedPreview('wall'));
    await act(() => result.current.lightAll());
    await act(async () => mocks.background?.('background'));
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('idle');
  });

  it('reports command failures without an unhandled rejection', async () => {
    mocks.show.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useSprayLedPreview('wall'));
    await act(() => result.current.show([1]));
    await waitFor(() => expect(result.current.error).toBe('unavailable'));
    expect(result.current.state).toBe('idle');
  });
});
