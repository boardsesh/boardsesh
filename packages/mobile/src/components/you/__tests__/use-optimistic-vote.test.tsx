// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// useVote wraps a React Query mutation. Stub it so optimistic transitions can be
// driven deterministically and the outgoing payload inspected. `votePending`
// lets a test simulate an in-flight vote at render time.
let votePending = false;
const mutate = vi.fn();
vi.mock('../../../lib/graphql/hooks', () => ({
  useVote: () => ({ mutate, isPending: votePending }),
}));

import { useOptimisticVote } from '../use-optimistic-vote';

type VoteOpts = {
  onSuccess: (summary: { upvotes: number; userVote: number }) => void;
  onError: (error: Error) => void;
};

describe('useOptimisticVote', () => {
  beforeEach(() => {
    mutate.mockReset();
    votePending = false;
  });

  it('reflects server state before any interaction', () => {
    const { result } = renderHook(() => useOptimisticVote('s1', 5, 1));
    expect(result.current.voted).toBe(true);
    expect(result.current.count).toBe(5);
  });

  it('flips optimistically and fires an upvote', () => {
    const { result } = renderHook(() => useOptimisticVote('s1', 5, null));

    act(() => result.current.toggle());

    expect(result.current.voted).toBe(true);
    expect(result.current.count).toBe(6);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ entityType: 'session', entityId: 's1', value: 1 });
  });

  it('sends value: 1 — never 0 — when un-voting (regression for #3189)', () => {
    // Already upvoted server-side. Tapping again removes the vote: the backend
    // only accepts +1/-1 (no 0/null "clear vote"), and toggles off when the
    // SAME value is resent — so the un-vote tap must also send `value: 1`.
    const { result } = renderHook(() => useOptimisticVote('s1', 5, 1));
    expect(result.current.voted).toBe(true);

    act(() => result.current.toggle());

    expect(result.current.voted).toBe(false);
    expect(result.current.count).toBe(4);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ entityType: 'session', entityId: 's1', value: 1 });
  });

  it('pins every wire value across a full none -> voted -> none -> voted transition sequence', () => {
    const { result } = renderHook(() => useOptimisticVote('s1', 5, null));

    // none -> voted
    act(() => result.current.toggle());
    expect(result.current.voted).toBe(true);
    act(() => (mutate.mock.calls[0][1] as VoteOpts).onSuccess({ upvotes: 6, userVote: 1 }));

    // voted -> none (the un-vote path this bug broke)
    act(() => result.current.toggle());
    expect(result.current.voted).toBe(false);
    act(() => (mutate.mock.calls[1][1] as VoteOpts).onSuccess({ upvotes: 5, userVote: 0 }));

    // none -> voted again
    act(() => result.current.toggle());
    expect(result.current.voted).toBe(true);

    expect(mutate).toHaveBeenCalledTimes(3);
    for (const call of mutate.mock.calls) {
      expect(call[0]).toEqual({ entityType: 'session', entityId: 's1', value: 1 });
    }
  });

  it('reconciles to the server summary on success', () => {
    const { result } = renderHook(() => useOptimisticVote('s1', 5, null));
    act(() => result.current.toggle());

    const opts = mutate.mock.calls[0][1] as VoteOpts;
    act(() => opts.onSuccess({ upvotes: 9, userVote: 1 }));

    expect(result.current.count).toBe(9);
    expect(result.current.voted).toBe(true);
  });

  it('rolls back to server values on error', () => {
    const { result } = renderHook(() => useOptimisticVote('s1', 5, null));
    act(() => result.current.toggle());
    expect(result.current.count).toBe(6); // optimistic

    const opts = mutate.mock.calls[0][1] as VoteOpts;
    act(() => opts.onError(new Error('nope')));

    expect(result.current.voted).toBe(false);
    expect(result.current.count).toBe(5);
  });

  it('ignores a tap while a previous vote is still in flight', () => {
    votePending = true;
    const { result } = renderHook(() => useOptimisticVote('s1', 5, null));

    act(() => result.current.toggle());

    expect(mutate).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);
  });

  it('resets optimistic state when recycled onto a different session', () => {
    const { result, rerender } = renderHook(({ id, up, uv }) => useOptimisticVote(id, up, uv), {
      initialProps: { id: 's1', up: 5, uv: null as number | null },
    });
    act(() => result.current.toggle());
    expect(result.current.count).toBe(6); // optimistic for s1

    rerender({ id: 's2', up: 2, uv: 1 });

    // s2's own server state — the s1 optimistic override must be gone.
    expect(result.current.voted).toBe(true);
    expect(result.current.count).toBe(2);
  });
});
