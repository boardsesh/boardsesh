// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import {
  dismissWallCapsule,
  resetWallCapsuleDismissalsForTests,
  useWallCapsuleDismissed,
  wallCapsuleOccurrenceKey,
} from '../wall-capsule-dismissal-store';

const preferences = vi.hoisted(() => ({
  stored: null as unknown,
  getPreference: vi.fn(),
  setPreference: vi.fn(),
}));
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));

vi.mock('../preference-store', () => ({
  getPreference: preferences.getPreference,
  setPreference: preferences.setPreference,
}));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const climb: BoardPresenceClimb = {
  climbUuid: 'wax-on',
  name: 'Wax On',
  sentAt: '2026-10-31T12:00:00.000Z',
  seq: 1,
};
const occurrence = wallCapsuleOccurrenceKey(41, climb);

function foreground() {
  act(() => {
    for (const listener of appState.listeners) listener('active');
  });
}

beforeEach(() => {
  resetWallCapsuleDismissalsForTests();
  preferences.stored = null;
  preferences.getPreference.mockReset().mockImplementation(async () => preferences.stored);
  preferences.setPreference.mockReset().mockImplementation(async (_key: string, stored: unknown) => {
    preferences.stored = stored;
  });
});

afterEach(() => {
  cleanup();
});

describe('wall capsule dismissal', () => {
  it('waits for persisted choices before revealing the capsule', async () => {
    const load = deferred<unknown>();
    preferences.getPreference.mockReturnValue(load.promise);
    const { result } = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    expect(result.current).toEqual({ loaded: false, dismissed: false });
    await act(async () => load.resolve({ version: 1, byBoard: { 41: occurrence } }));
    expect(result.current).toEqual({ loaded: true, dismissed: true });
  });

  it('restores a dismissal after unmount and a cold launch', async () => {
    const first = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, occurrence));
    expect(first.result.current.dismissed).toBe(true);
    await waitFor(() => expect(preferences.stored).toEqual({ version: 1, byBoard: { 41: occurrence } }));
    first.unmount();

    const remount = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    expect(remount.result.current.dismissed).toBe(true);
    remount.unmount();
    resetWallCapsuleDismissalsForTests();
    const restarted = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    expect(restarted.result.current.loaded).toBe(false);
    await waitFor(() => expect(restarted.result.current).toEqual({ loaded: true, dismissed: true }));
  });

  it('shows a fresh lighting of the same climb and keeps dismissal scoped to its board', async () => {
    const { result, rerender } = renderHook(({ boardId, key }) => useWallCapsuleDismissed(boardId, key), {
      initialProps: { boardId: 41, key: occurrence },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, occurrence));
    rerender({ boardId: 42, key: wallCapsuleOccurrenceKey(42, climb) });
    expect(result.current.dismissed).toBe(false);
    rerender({ boardId: 41, key: occurrence });
    expect(result.current.dismissed).toBe(true);
    rerender({ boardId: 41, key: wallCapsuleOccurrenceKey(41, { ...climb, seq: 2 }) });
    expect(result.current.dismissed).toBe(false);
    expect(wallCapsuleOccurrenceKey(41, { ...climb, sentAt: '2026-10-31T13:00:00.000Z' })).not.toBe(occurrence);
    await waitFor(() => expect(preferences.setPreference).toHaveBeenCalledOnce());
  });

  it('merges an in-flight swipe with stored dismissals for other boards', async () => {
    const load = deferred<unknown>();
    preferences.getPreference.mockReturnValue(load.promise);
    const { result } = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    act(() => dismissWallCapsule(41, occurrence));
    expect(result.current.dismissed).toBe(true);
    expect(preferences.setPreference).not.toHaveBeenCalled();
    await act(async () => load.resolve({ version: 1, byBoard: { 41: 'older-event', 42: 'another-board' } }));
    expect(result.current).toEqual({ loaded: true, dismissed: true });
    await waitFor(() =>
      expect(preferences.stored).toEqual({
        version: 1,
        byBoard: { 41: occurrence, 42: 'another-board' },
      }),
    );
    expect(preferences.getPreference).toHaveBeenCalledOnce();
  });

  it.each(['remount', 'foreground'] as const)('retries a failed hydration on %s', async (retry) => {
    preferences.stored = { version: 1, byBoard: { 41: occurrence } };
    preferences.getPreference.mockRejectedValueOnce(new Error('Device locked'));
    let mounted = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    await act(async () => {});
    expect(mounted.result.current.loaded).toBe(false);
    if (retry === 'remount') {
      mounted.unmount();
      mounted = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    } else foreground();
    await waitFor(() => expect(mounted.result.current).toEqual({ loaded: true, dismissed: true }));
    expect(preferences.getPreference).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite other boards while storage cannot be read', async () => {
    preferences.stored = { version: 1, byBoard: { 42: 'another-board' } };
    preferences.getPreference.mockRejectedValueOnce(new Error('Device locked'));
    const { result } = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    await act(async () => {});
    act(() => dismissWallCapsule(41, occurrence));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.dismissed).toBe(true);
    await waitFor(() =>
      expect(preferences.stored).toEqual({
        version: 1,
        byBoard: { 41: occurrence, 42: 'another-board' },
      }),
    );
  });

  it('serializes writes so an older dismissal cannot finish last', async () => {
    const firstWrite = deferred<void>();
    preferences.setPreference.mockImplementationOnce(async (_key: string, stored: unknown) => {
      await firstWrite.promise;
      preferences.stored = stored;
    });
    const { result } = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, occurrence));
    await waitFor(() => expect(preferences.setPreference).toHaveBeenCalledOnce());
    const nextOccurrence = wallCapsuleOccurrenceKey(41, { ...climb, seq: 2 });
    act(() => dismissWallCapsule(41, nextOccurrence));
    await act(async () => {});
    expect(preferences.setPreference).toHaveBeenCalledOnce();
    await act(async () => firstWrite.resolve());
    await waitFor(() => expect(preferences.stored).toEqual({ version: 1, byBoard: { 41: nextOccurrence } }));
    expect(preferences.setPreference).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed write hidden and retries it on foreground', async () => {
    preferences.setPreference.mockRejectedValueOnce(new Error('Disk busy'));
    const { result } = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, occurrence));
    await act(async () => {});
    expect(result.current.dismissed).toBe(true);
    foreground();
    await waitFor(() => expect(preferences.stored).toEqual({ version: 1, byBoard: { 41: occurrence } }));
    expect(preferences.setPreference).toHaveBeenCalledTimes(2);
  });

  it('keeps the latest successful write when an earlier queued write fails', async () => {
    const firstWrite = deferred<void>();
    preferences.setPreference.mockImplementationOnce(async () => {
      await firstWrite.promise;
      throw new Error('Older write failed');
    });
    const { result } = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, occurrence));
    await waitFor(() => expect(preferences.setPreference).toHaveBeenCalledOnce());
    const nextOccurrence = wallCapsuleOccurrenceKey(41, { ...climb, seq: 2 });
    act(() => dismissWallCapsule(41, nextOccurrence));
    await act(async () => firstWrite.resolve());
    await waitFor(() => expect(preferences.stored).toEqual({ version: 1, byBoard: { 41: nextOccurrence } }));
    foreground();
    await act(async () => {});
    expect(preferences.setPreference).toHaveBeenCalledTimes(2);
  });

  it('ignores an unsupported stored version and cleans up its listener', async () => {
    preferences.stored = { version: 2, byBoard: { 41: occurrence } };
    const { result, unmount } = renderHook(() => useWallCapsuleDismissed(41, occurrence));
    await waitFor(() => expect(result.current).toEqual({ loaded: true, dismissed: false }));
    unmount();
    expect(appState.listeners.size).toBe(0);
  });

  it('does not load or subscribe without a board and occurrence', () => {
    const { result } = renderHook(() => useWallCapsuleDismissed(null, null));
    expect(result.current).toEqual({ loaded: true, dismissed: false });
    expect(preferences.getPreference).not.toHaveBeenCalled();
    expect(appState.listeners.size).toBe(0);
  });
});
