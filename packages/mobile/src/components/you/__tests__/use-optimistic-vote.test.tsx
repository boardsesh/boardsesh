// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// useVote wraps a React Query mutation. Stub it so optimistic transitions can be
// driven deterministically and the outgoing payload inspected. `votePending`
// lets a test simulate an in-flight vote at render time.
let votePending = false;
const mutate = vi.fn();
vi.mock('../../../lib/graphql/hooks', () => ({
  useVote: () => ({ mutateWithReceipt: mutate, isPending: votePending }),
}));

vi.mock('../../../lib/graphql/use-http-query-scope', () => ({
  useHttpQueryScope: () => ({ scoped: false, assertView: () => {} }),
}));

import { useOptimisticVote } from '../use-optimistic-vote';
import { invalidateCredentialSnapshots } from '../../../lib/privacy/privacy-cache';

type Summary = { upvotes: number; userVote: number };
const completions: { resolve: (summary: Summary) => void; reject: (error: Error) => void }[] = [];
async function succeed(index: number, summary: Summary) {
  await act(async () => completions[index].resolve(summary));
}

beforeEach(() => {
  mutate.mockReset();
  votePending = false;
  completions.length = 0;
  mutate.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        completions.push({
          resolve: (summary: Summary) => resolve({ result: summary, assertCurrent: () => {}, dispose: () => {} }),
          reject,
        });
      }),
  );
});

describe('useOptimisticVote', () => {
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

  it('pins every wire value across a full none -> voted -> none -> voted transition sequence', async () => {
    const { result } = renderHook(() => useOptimisticVote('s1', 5, null));

    // none -> voted
    act(() => result.current.toggle());
    expect(result.current.voted).toBe(true);
    await succeed(0, { upvotes: 6, userVote: 1 });

    // voted -> none (the un-vote path this bug broke)
    act(() => result.current.toggle());
    expect(result.current.voted).toBe(false);
    await succeed(1, { upvotes: 5, userVote: 0 });

    // none -> voted again
    act(() => result.current.toggle());
    expect(result.current.voted).toBe(true);

    expect(mutate).toHaveBeenCalledTimes(3);
    for (const call of mutate.mock.calls) {
      expect(call[0]).toEqual({ entityType: 'session', entityId: 's1', value: 1 });
    }
  });

  it('reconciles to the server summary on success', async () => {
    const { result } = renderHook(() => useOptimisticVote('s1', 5, null));
    act(() => result.current.toggle());

    await succeed(0, { upvotes: 9, userVote: 1 });

    expect(result.current.count).toBe(9);
    expect(result.current.voted).toBe(true);
  });

  it('rolls back to server values on error', async () => {
    const { result } = renderHook(() => useOptimisticVote('s1', 5, null));
    act(() => result.current.toggle());
    expect(result.current.count).toBe(6); // optimistic

    await act(async () => completions[0].reject(new Error('nope')));

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

describe('original optimistic vote continuations', () => {
  it.each(['entity', 'entity-type', 'ABA'] as const)('keeps a late success out of a recycled %s', async (change) => {
    const { result, rerender } = renderHook(({ id, type }) => useOptimisticVote(id, 5, null, type), {
      initialProps: { id: 's1', type: 'session' as 'session' | 'tick' },
    });
    const originalToggle = result.current.toggle;
    act(() => originalToggle());
    if (change === 'entity-type') rerender({ id: 's1', type: 'tick' });
    else {
      rerender({ id: 's2', type: 'session' });
      if (change === 'ABA') rerender({ id: 's1', type: 'session' });
    }
    await succeed(0, { upvotes: 99, userVote: 1 });
    expect(result.current.count).toBe(5);
    expect(result.current.voted).toBe(false);
    act(() => originalToggle());
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('keeps its native vote going after unmount, and ends it on sign-out', () => {
    // A climber who upvotes and switches tab keeps the vote. Only an account
    // change ends it, so the old account's vote never lands under the next.
    const { result, unmount } = renderHook(() => useOptimisticVote('s1', 5, null));
    act(() => result.current.toggle());
    const options = mutate.mock.calls[0][1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);
    unmount();
    expect(options.signal.aborted).toBe(false);
    invalidateCredentialSnapshots();
    expect(options.signal.aborted).toBe(true);
  });
});
