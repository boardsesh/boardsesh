// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

const spies = vi.hoisted(() => ({ shouldRequestSessionStoreReview: vi.fn(async () => true) }));

vi.mock('../../store-review', () => ({
  SESSION_STORE_REVIEW_CANDIDATE_PARAM: '1',
  shouldRequestSessionStoreReview: spies.shouldRequestSessionStoreReview,
}));

import { usePostSessionPrompt } from '../use-post-session-prompt';

const summary = { sessionId: 'session-1', totalSends: 7 };

beforeEach(() => {
  vi.clearAllMocks();
  spies.shouldRequestSessionStoreReview.mockResolvedValue(true);
});
afterEach(() => cleanup());

describe('usePostSessionPrompt', () => {
  it('gives the review the screen when it is actually going to fire', async () => {
    const { result } = renderHook(() => usePostSessionPrompt(summary, '1'));
    await waitFor(() => expect(result.current).toBe('review'));
  });

  // The whole reason this hook exists: totalSends is 7, so the bare eligibility
  // predicate is true, but the 90-day cooldown means no review appears — and the
  // offline offer is exactly what should take that slot.
  it('hands the screen to the offline offer when the review is on cooldown', async () => {
    spies.shouldRequestSessionStoreReview.mockResolvedValue(false);
    const { result } = renderHook(() => usePostSessionPrompt(summary, '1'));
    await waitFor(() => expect(result.current).toBe('offline'));
  });

  it('never consults the review when the screen was not opened as a candidate', async () => {
    const { result } = renderHook(() => usePostSessionPrompt(summary, undefined));
    await waitFor(() => expect(result.current).toBe('offline'));
    expect(spies.shouldRequestSessionStoreReview).not.toHaveBeenCalled();
  });

  it('resolves the review decision once, not on every render', async () => {
    const { result, rerender } = renderHook(() => usePostSessionPrompt(summary, '1'));
    await waitFor(() => expect(result.current).toBe('review'));
    rerender();
    rerender();
    expect(spies.shouldRequestSessionStoreReview).toHaveBeenCalledTimes(1);
  });

  it('reports no prompt without a summary', async () => {
    const { result } = renderHook(() => usePostSessionPrompt(null, '1'));
    await waitFor(() => expect(result.current).toBe('none'));
  });
});
