// @vitest-environment jsdom
//
// The in-session "Show this session live" switch. These pin:
// - it never claims a value it doesn't know (the `session` query is null while
//   the live roster is empty, and "on" there would lie about a private session);
// - a landed save writes the server's echo everywhere and fires the event;
// - a failed save snaps back with a toast;
// - saves run one at a time, so quick flips can't land out of order.
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

const harness = vi.hoisted(() => ({
  track: vi.fn(),
  showToast: vi.fn(),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  mutateAsync: vi.fn(),
  pending: [] as Array<{ variables: { input: { sessionId: string; isPublic: boolean } }; deferred: Deferred }>,
  stored: null as boolean | null,
  storedRead: null as Promise<boolean | null> | null,
  getStoredSessionVisibility: vi.fn(),
  setStoredSessionVisibility: vi.fn(async () => {}),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: harness.setQueryData, invalidateQueries: harness.invalidateQueries }),
}));
vi.mock('../../../../lib/graphql/hooks', () => ({ useUpdateSession: () => ({ mutateAsync: harness.mutateAsync }) }));
vi.mock('../../../../lib/analytics', () => ({ track: harness.track }));
vi.mock('../../../../lib/session-store', () => ({
  getStoredSessionVisibility: harness.getStoredSessionVisibility,
  setStoredSessionVisibility: harness.setStoredSessionVisibility,
}));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: harness.showToast }) }));

import { isKnownSessionCreator, useSessionVisibilityToggle } from '../use-session-visibility-toggle';

type HookProps = { sessionId: string | null; serverIsPublic: boolean | undefined; rosterResolved: boolean };

function renderToggle(overrides: Partial<HookProps> = {}) {
  const initialProps: HookProps = { sessionId: 'session-1', serverIsPublic: true, rosterResolved: true, ...overrides };
  return renderHook((props: HookProps) => useSessionVisibilityToggle(props), { initialProps });
}

/** Settles the Nth updateSession call with the server's echo. */
async function landSave(index: number, echoedIsPublic: boolean) {
  await act(async () => {
    harness.pending[index].deferred.resolve({
      sessionId: 'session-1',
      name: null,
      notes: null,
      isPublic: echoedIsPublic,
    });
  });
}

beforeEach(() => {
  harness.track.mockClear();
  harness.showToast.mockClear();
  harness.setQueryData.mockClear();
  harness.invalidateQueries.mockClear();
  harness.setStoredSessionVisibility.mockClear();
  harness.pending = [];
  harness.stored = null;
  harness.storedRead = null;
  harness.getStoredSessionVisibility
    .mockReset()
    .mockImplementation(() => harness.storedRead ?? Promise.resolve(harness.stored));
  harness.mutateAsync.mockReset().mockImplementation(
    (variables: { input: { sessionId: string; isPublic: boolean } }) =>
      new Promise((resolve, reject) => {
        harness.pending.push({ variables, deferred: { resolve, reject } });
      }),
  );
});

describe('useSessionVisibilityToggle: what the switch shows', () => {
  it('knows nothing (null, never "on") while the server is silent and nothing is stored', async () => {
    const { result } = renderToggle({ serverIsPublic: undefined });
    await waitFor(() => expect(harness.getStoredSessionVisibility).toHaveBeenCalledWith('session-1'));

    expect(result.current.isPublic).toBeNull();
  });

  it('shows the private value this device started the session with, even while the server is silent', async () => {
    harness.stored = false;
    const { result } = renderToggle({ serverIsPublic: undefined });

    await waitFor(() => expect(result.current.isPublic).toBe(false));
  });

  it('prefers the stored value over the server, and uses the server when nothing is stored', async () => {
    harness.stored = false;
    const stored = renderToggle({ serverIsPublic: true });
    await waitFor(() => expect(stored.result.current.isPublic).toBe(false));

    harness.stored = null;
    const server = renderToggle({ sessionId: 'session-2', serverIsPublic: true });
    await waitFor(() => expect(server.result.current.isPublic).toBe(true));
  });

  it('claims nothing until the stored value has been read', async () => {
    let finishRead: (value: boolean | null) => void = () => {};
    harness.storedRead = new Promise((resolve) => {
      finishRead = resolve;
    });
    const { result } = renderToggle({ serverIsPublic: true });
    expect(result.current.isPublic).toBeNull();

    await act(async () => {
      finishRead(null);
    });
    expect(result.current.isPublic).toBe(true);
  });

  it('refetches the session preview once the roster names us and the server value is still unknown', async () => {
    const { rerender } = renderToggle({ serverIsPublic: undefined, rosterResolved: false });
    expect(harness.invalidateQueries).not.toHaveBeenCalled();

    rerender({ sessionId: 'session-1', serverIsPublic: undefined, rosterResolved: true });

    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessionPreview', 'session-1'] });
  });
});

describe('useSessionVisibilityToggle: saving', () => {
  it('flips at once, then writes the echoed value to the cache and the store and fires the event', async () => {
    const { result } = renderToggle();
    await waitFor(() => expect(result.current.isPublic).toBe(true));

    act(() => {
      result.current.setIsPublic(false);
    });
    expect(result.current.isPublic).toBe(false);
    expect(harness.mutateAsync).toHaveBeenCalledWith({ input: { sessionId: 'session-1', isPublic: false } });
    expect(harness.track).not.toHaveBeenCalled();

    await landSave(0, false);

    expect(result.current.isPublic).toBe(false);
    const patch = harness.setQueryData.mock.calls[0][1] as (previous: unknown) => unknown;
    expect(patch({ id: 'session-1', isPublic: true })).toEqual({ id: 'session-1', isPublic: false });
    expect(harness.setStoredSessionVisibility).toHaveBeenCalledWith('session-1', false);
    expect(harness.track).toHaveBeenCalledWith('Session Visibility Changed', { isPublic: false, phase: 'in_session' });
    expect(harness.showToast).not.toHaveBeenCalled();
  });

  it('snaps back to the known value with an error toast when the save fails', async () => {
    const { result } = renderToggle();
    await waitFor(() => expect(result.current.isPublic).toBe(true));

    act(() => {
      result.current.setIsPublic(false);
    });
    await act(async () => {
      harness.pending[0].deferred.reject(new Error('Network request failed'));
    });

    expect(result.current.isPublic).toBe(true);
    expect(harness.showToast).toHaveBeenCalledWith('mobile.sessionVisibility.updateError', 'error');
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessionPreview', 'session-1'] });
    expect(harness.setStoredSessionVisibility).not.toHaveBeenCalled();
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('keeps one save in flight and sends the latest wish once it lands', async () => {
    const { result } = renderToggle();
    await waitFor(() => expect(result.current.isPublic).toBe(true));

    act(() => {
      result.current.setIsPublic(false);
    });
    act(() => {
      result.current.setIsPublic(true);
    });
    expect(result.current.isPublic).toBe(true);
    // The second flip waits for the first save instead of racing it.
    expect(harness.mutateAsync).toHaveBeenCalledTimes(1);

    await landSave(0, false);
    expect(harness.mutateAsync).toHaveBeenCalledTimes(2);
    expect(harness.pending[1].variables).toEqual({ input: { sessionId: 'session-1', isPublic: true } });
    expect(result.current.isPublic).toBe(true);

    await landSave(1, true);
    expect(harness.mutateAsync).toHaveBeenCalledTimes(2);
    expect(result.current.isPublic).toBe(true);
    expect(harness.setStoredSessionVisibility).toHaveBeenLastCalledWith('session-1', true);
    expect(harness.track.mock.calls).toEqual([
      ['Session Visibility Changed', { isPublic: false, phase: 'in_session' }],
      ['Session Visibility Changed', { isPublic: true, phase: 'in_session' }],
    ]);
  });

  it('sends nothing more when the latest wish matches what the in-flight save confirmed', async () => {
    const { result } = renderToggle();
    await waitFor(() => expect(result.current.isPublic).toBe(true));

    act(() => {
      result.current.setIsPublic(false);
    });
    act(() => {
      result.current.setIsPublic(true);
    });
    act(() => {
      result.current.setIsPublic(false);
    });

    await landSave(0, false);

    expect(harness.mutateAsync).toHaveBeenCalledTimes(1);
    expect(result.current.isPublic).toBe(false);
  });

  it('does nothing without a session', () => {
    const { result } = renderToggle({ sessionId: null, serverIsPublic: undefined });

    act(() => {
      result.current.setIsPublic(false);
    });

    expect(harness.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.isPublic).toBeNull();
  });
});

describe('isKnownSessionCreator', () => {
  it('trusts this phone having started the session before the roster names us', () => {
    expect(isKnownSessionCreator({ startedOnThisDevice: true, ownerUserId: undefined, selfUserId: null })).toBe(true);
  });

  it("recognises the creator's other phone by the owner id", () => {
    expect(isKnownSessionCreator({ startedOnThisDevice: false, ownerUserId: 'user-1', selfUserId: 'user-1' })).toBe(
      true,
    );
  });

  it('hides the switch from joiners and while ownership is unknown', () => {
    expect(isKnownSessionCreator({ startedOnThisDevice: false, ownerUserId: 'user-1', selfUserId: 'user-2' })).toBe(
      false,
    );
    expect(isKnownSessionCreator({ startedOnThisDevice: false, ownerUserId: null, selfUserId: 'user-2' })).toBe(false);
    expect(isKnownSessionCreator({ startedOnThisDevice: false, ownerUserId: 'user-1', selfUserId: null })).toBe(false);
  });
});
