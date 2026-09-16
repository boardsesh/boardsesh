// @vitest-environment jsdom
//
// The in-session "Show this session live" switch flips before the save lands.
// These pin the three outcomes a creator can see: the save lands (the switch
// stays, the cache follows, the event fires), the save fails (the switch snaps
// back with a toast), and a slow earlier save settles after a newer flip (it is
// ignored).
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

const harness = vi.hoisted(() => ({
  track: vi.fn(),
  showToast: vi.fn(),
  reportHandledError: vi.fn(),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  mutateAsync: vi.fn(),
  pending: [] as Deferred[],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: harness.setQueryData, invalidateQueries: harness.invalidateQueries }),
}));
vi.mock('../../../../lib/graphql/hooks', () => ({ useUpdateSession: () => ({ mutateAsync: harness.mutateAsync }) }));
vi.mock('../../../../lib/analytics', () => ({ track: harness.track }));
vi.mock('../../../../lib/error-reporting', () => ({ reportHandledError: harness.reportHandledError }));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: harness.showToast }) }));

import { isKnownSessionCreator, useSessionVisibilityToggle } from '../use-session-visibility-toggle';

beforeEach(() => {
  harness.track.mockClear();
  harness.showToast.mockClear();
  harness.reportHandledError.mockClear();
  harness.setQueryData.mockClear();
  harness.invalidateQueries.mockClear();
  harness.pending = [];
  harness.mutateAsync.mockReset().mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        harness.pending.push({ resolve, reject });
      }),
  );
});

describe('useSessionVisibilityToggle', () => {
  it('shows the server value, and public while it is unknown', () => {
    const { result, rerender } = renderHook(
      ({ serverIsPublic }: { serverIsPublic: boolean | undefined }) =>
        useSessionVisibilityToggle('session-1', serverIsPublic),
      { initialProps: { serverIsPublic: undefined as boolean | undefined } },
    );
    expect(result.current.isPublic).toBe(true);

    rerender({ serverIsPublic: false });
    expect(result.current.isPublic).toBe(false);
  });

  it('flips at once, saves, patches the preview cache and fires the event once the save lands', async () => {
    const { result } = renderHook(() => useSessionVisibilityToggle('session-1', true));

    act(() => {
      result.current.setIsPublic(false);
    });
    expect(result.current.isPublic).toBe(false);
    expect(harness.mutateAsync).toHaveBeenCalledWith({ input: { sessionId: 'session-1', isPublic: false } });
    expect(harness.track).not.toHaveBeenCalled();

    await act(async () => {
      harness.pending[0].resolve({ sessionId: 'session-1', name: null, notes: null });
    });

    expect(result.current.isPublic).toBe(false);
    expect(harness.setQueryData).toHaveBeenCalledWith(['sessionPreview', 'session-1'], expect.any(Function));
    const patch = harness.setQueryData.mock.calls[0][1] as (previous: unknown) => unknown;
    expect(patch({ id: 'session-1', isPublic: true })).toEqual({ id: 'session-1', isPublic: false });
    expect(harness.track).toHaveBeenCalledWith('Session Visibility Changed', { isPublic: false, phase: 'in_session' });
    expect(harness.showToast).not.toHaveBeenCalled();
  });

  it('snaps back to the server value with an error toast when the save fails', async () => {
    const { result } = renderHook(() => useSessionVisibilityToggle('session-1', true));

    act(() => {
      result.current.setIsPublic(false);
    });
    expect(result.current.isPublic).toBe(false);

    await act(async () => {
      harness.pending[0].reject(new Error('Network request failed'));
    });

    expect(result.current.isPublic).toBe(true);
    expect(harness.showToast).toHaveBeenCalledWith('mobile.sessionVisibility.updateError', 'error');
    expect(harness.reportHandledError).toHaveBeenCalledTimes(1);
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessionPreview', 'session-1'] });
    expect(harness.setQueryData).not.toHaveBeenCalled();
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('ignores a slow earlier save that settles after a newer flip', async () => {
    const { result } = renderHook(() => useSessionVisibilityToggle('session-1', true));

    act(() => {
      result.current.setIsPublic(false);
    });
    act(() => {
      result.current.setIsPublic(true);
    });
    expect(result.current.isPublic).toBe(true);

    // The first save fails late. The newer flip still owns the switch.
    await act(async () => {
      harness.pending[0].reject(new Error('timeout'));
    });
    expect(result.current.isPublic).toBe(true);
    expect(harness.showToast).not.toHaveBeenCalled();

    await act(async () => {
      harness.pending[1].resolve({ sessionId: 'session-1', name: null, notes: null });
    });
    expect(result.current.isPublic).toBe(true);
    expect(harness.track).toHaveBeenCalledTimes(1);
    expect(harness.track).toHaveBeenCalledWith('Session Visibility Changed', { isPublic: true, phase: 'in_session' });
  });

  it('does nothing without a session', () => {
    const { result } = renderHook(() => useSessionVisibilityToggle(null, undefined));

    act(() => {
      result.current.setIsPublic(false);
    });

    expect(harness.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.isPublic).toBe(true);
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
