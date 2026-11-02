// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import {
  dismissWallCapsule,
  resetWallCapsuleDismissalsForTests,
  useWallCapsuleDismissal,
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
const hidden = { climbUuid: 'wax-on', sentAt: '2026-10-31T12:00:00.000Z' };
// The same climb reported again: a reconnect, another device's re-light, a mirror flip.
const relit: BoardPresenceClimb = { ...climb, sentAt: '2026-10-31T12:20:00.000Z', seq: 2 };
// A different climb lit after it.
const nextClimb: BoardPresenceClimb = {
  climbUuid: 'the-eyes',
  name: 'The Eyes',
  sentAt: '2026-10-31T12:30:00.000Z',
  seq: 3,
};
const stored = (byBoard: Record<string, { climbUuid: string; sentAt: string }>) => ({ version: 2, byBoard });
const shown = { loaded: true, dismissed: false, hiddenClimbUuid: null };
const hiddenState = { loaded: true, dismissed: true, hiddenClimbUuid: 'wax-on' };

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

type HookProps = { boardId: number | null; wall: BoardPresenceClimb | null };
const renderDismissal = (initialProps: HookProps = { boardId: 41, wall: climb }) =>
  renderHook(({ boardId, wall }: HookProps) => useWallCapsuleDismissal(boardId, wall), { initialProps });

describe('wall capsule dismissal', () => {
  it('waits for persisted choices before revealing the capsule', async () => {
    const load = deferred<unknown>();
    preferences.getPreference.mockReturnValue(load.promise);
    const { result } = renderDismissal();
    expect(result.current).toEqual({ loaded: false, dismissed: false, hiddenClimbUuid: null });
    await act(async () => load.resolve(stored({ 41: hidden })));
    expect(result.current).toEqual(hiddenState);
  });

  it('restores a dismissal after unmount and a cold launch', async () => {
    const first = renderDismissal();
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, climb));
    expect(first.result.current).toEqual(hiddenState);
    await waitFor(() => expect(preferences.stored).toEqual(stored({ 41: hidden })));
    first.unmount();

    const remount = renderDismissal();
    expect(remount.result.current.dismissed).toBe(true);
    remount.unmount();
    resetWallCapsuleDismissalsForTests();
    const restarted = renderDismissal();
    expect(restarted.result.current.loaded).toBe(false);
    await waitFor(() => expect(restarted.result.current).toEqual(hiddenState));
  });

  // Owner contract: hidden until a DIFFERENT climb goes up on that wall.
  it('keeps the same climb hidden through a re-report, and scopes it to its board', async () => {
    const { result, rerender } = renderDismissal();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, climb));
    rerender({ boardId: 42, wall: climb });
    expect(result.current).toEqual(shown);
    rerender({ boardId: 41, wall: climb });
    expect(result.current.dismissed).toBe(true);
    // A reconnect, the iPad re-lighting it, a mirror flip: a new lit time, the same climb.
    rerender({ boardId: 41, wall: relit });
    expect(result.current).toEqual(hiddenState);
    // The feed dropping keeps the board's Hide for surfaces that draw the climb without presence.
    rerender({ boardId: 41, wall: null });
    expect(result.current).toEqual({ loaded: true, dismissed: false, hiddenClimbUuid: 'wax-on' });
    await waitFor(() => expect(preferences.setPreference).toHaveBeenCalledOnce());
    expect(preferences.stored).toEqual(stored({ 41: hidden }));
  });

  it('ends the Hide when a different climb goes up, so the hidden climb shows if it comes back', async () => {
    const { result, rerender } = renderDismissal();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, climb));
    rerender({ boardId: 41, wall: nextClimb });
    expect(result.current).toEqual(shown);
    await waitFor(() => expect(preferences.stored).toEqual(stored({})));
    rerender({ boardId: 41, wall: { ...climb, sentAt: '2026-10-31T12:40:00.000Z', seq: 4 } });
    expect(result.current).toEqual(shown);
  });

  it('ends the Hide only for its own board', async () => {
    preferences.stored = stored({ 41: hidden, 42: hidden });
    const { result, rerender } = renderDismissal({ boardId: 42, wall: nextClimb });
    await waitFor(() => expect(preferences.stored).toEqual(stored({ 41: hidden })));
    expect(result.current).toEqual(shown);
    rerender({ boardId: 41, wall: climb });
    expect(result.current).toEqual(hiddenState);
  });

  it('keeps the Hide when an older climb is reported late', async () => {
    const { result, rerender } = renderDismissal();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, climb));
    rerender({ boardId: 41, wall: { ...nextClimb, sentAt: '2026-10-31T11:00:00.000Z' } });
    expect(result.current).toEqual({ loaded: true, dismissed: false, hiddenClimbUuid: 'wax-on' });
    rerender({ boardId: 41, wall: climb });
    expect(result.current).toEqual(hiddenState);
  });

  it('ends a stored Hide when a different climb is already up at launch', async () => {
    preferences.stored = stored({ 41: hidden });
    const { result } = renderDismissal({ boardId: 41, wall: nextClimb });
    await waitFor(() => expect(preferences.stored).toEqual(stored({})));
    expect(result.current).toEqual(shown);
  });

  it('keeps a Hide made before the update', async () => {
    // Version 1 (#7169) stored one lighting per board as [boardId, seq, sentAt, climbUuid].
    preferences.stored = {
      version: 1,
      byBoard: { 41: JSON.stringify([41, 1, climb.sentAt, climb.climbUuid]), 42: 'not-json' },
    };
    const { result } = renderDismissal({ boardId: 41, wall: relit });
    await waitFor(() => expect(result.current).toEqual(hiddenState));
  });

  it('keys an occurrence on board, climb and lit time only', () => {
    const occurrence = wallCapsuleOccurrenceKey(41, climb);
    // A reseeded board sequence on the same lighting is the same occurrence.
    const reseeded: BoardPresenceClimb = { ...climb, seq: 900 };
    expect(wallCapsuleOccurrenceKey(41, reseeded)).toBe(occurrence);
    expect(occurrence).toBe(JSON.stringify([41, 'wax-on', '2026-10-31T12:00:00.000Z']));
    expect(wallCapsuleOccurrenceKey(42, climb)).not.toBe(occurrence);
    expect(wallCapsuleOccurrenceKey(41, relit)).not.toBe(occurrence);
  });

  it('merges an in-flight Hide with stored dismissals for other boards', async () => {
    const load = deferred<unknown>();
    preferences.getPreference.mockReturnValue(load.promise);
    const { result } = renderDismissal();
    act(() => dismissWallCapsule(41, climb));
    expect(result.current.dismissed).toBe(true);
    expect(preferences.setPreference).not.toHaveBeenCalled();
    const otherBoard = { climbUuid: 'another-climb', sentAt: '2026-10-31T09:00:00.000Z' };
    await act(async () =>
      load.resolve(stored({ 41: { climbUuid: 'older-climb', sentAt: '2026-10-31T08:00:00.000Z' }, 42: otherBoard })),
    );
    expect(result.current).toEqual(hiddenState);
    await waitFor(() => expect(preferences.stored).toEqual(stored({ 41: hidden, 42: otherBoard })));
    expect(preferences.getPreference).toHaveBeenCalledOnce();
  });

  it.each(['remount', 'foreground'] as const)('retries a failed hydration on %s', async (retry) => {
    preferences.stored = stored({ 41: hidden });
    preferences.getPreference.mockRejectedValueOnce(new Error('Device locked'));
    let mounted = renderDismissal();
    await act(async () => {});
    expect(mounted.result.current.loaded).toBe(false);
    if (retry === 'remount') {
      mounted.unmount();
      mounted = renderDismissal();
    } else foreground();
    await waitFor(() => expect(mounted.result.current).toEqual(hiddenState));
    expect(preferences.getPreference).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite other boards while storage cannot be read', async () => {
    const otherBoard = { climbUuid: 'another-climb', sentAt: '2026-10-31T09:00:00.000Z' };
    preferences.stored = stored({ 42: otherBoard });
    preferences.getPreference.mockRejectedValueOnce(new Error('Device locked'));
    const { result } = renderDismissal();
    await act(async () => {});
    act(() => dismissWallCapsule(41, climb));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.dismissed).toBe(true);
    await waitFor(() => expect(preferences.stored).toEqual(stored({ 41: hidden, 42: otherBoard })));
  });

  it('serializes writes so an older dismissal cannot finish last', async () => {
    const firstWrite = deferred<void>();
    preferences.setPreference.mockImplementationOnce(async (_key: string, value: unknown) => {
      await firstWrite.promise;
      preferences.stored = value;
    });
    const { result } = renderDismissal();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, climb));
    await waitFor(() => expect(preferences.setPreference).toHaveBeenCalledOnce());
    act(() => dismissWallCapsule(41, relit));
    await act(async () => {});
    expect(preferences.setPreference).toHaveBeenCalledOnce();
    await act(async () => firstWrite.resolve());
    await waitFor(() =>
      expect(preferences.stored).toEqual(stored({ 41: { climbUuid: 'wax-on', sentAt: relit.sentAt } })),
    );
    expect(preferences.setPreference).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed write hidden and retries it on foreground', async () => {
    preferences.setPreference.mockRejectedValueOnce(new Error('Disk busy'));
    const { result } = renderDismissal();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, climb));
    await act(async () => {});
    expect(result.current.dismissed).toBe(true);
    foreground();
    await waitFor(() => expect(preferences.stored).toEqual(stored({ 41: hidden })));
    expect(preferences.setPreference).toHaveBeenCalledTimes(2);
  });

  it('keeps the latest successful write when an earlier queued write fails', async () => {
    const firstWrite = deferred<void>();
    preferences.setPreference.mockImplementationOnce(async () => {
      await firstWrite.promise;
      throw new Error('Older write failed');
    });
    const { result } = renderDismissal();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => dismissWallCapsule(41, climb));
    await waitFor(() => expect(preferences.setPreference).toHaveBeenCalledOnce());
    act(() => dismissWallCapsule(41, relit));
    await act(async () => firstWrite.resolve());
    await waitFor(() =>
      expect(preferences.stored).toEqual(stored({ 41: { climbUuid: 'wax-on', sentAt: relit.sentAt } })),
    );
    foreground();
    await act(async () => {});
    expect(preferences.setPreference).toHaveBeenCalledTimes(2);
  });

  it('ignores an unsupported stored version and cleans up its listener', async () => {
    preferences.stored = { version: 99, byBoard: { 41: hidden } };
    const { result, unmount } = renderDismissal();
    await waitFor(() => expect(result.current).toEqual(shown));
    unmount();
    expect(appState.listeners.size).toBe(0);
  });

  it('does not load or subscribe without a board', () => {
    const { result } = renderDismissal({ boardId: null, wall: climb });
    expect(result.current).toEqual(shown);
    expect(preferences.getPreference).not.toHaveBeenCalled();
    expect(appState.listeners.size).toBe(0);
  });
});
