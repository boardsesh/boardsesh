// @vitest-environment jsdom
//
// The reset API surface, which is the one seam between the reviewed decisions
// and the wall.
//
// The state machines under it are covered on their own — what they cannot see
// is what happens when the network does not cooperate, or what a successful
// commit has to invalidate afterwards. Both matter more than usual here:
//
//  - a failed PROPOSE must leave the flow with nothing to review rather than an
//    empty review, because an empty review reads as "every hold has gone";
//  - a failed COMMIT must leave the review intact, since the owner's verdicts on
//    a hundred rings are the expensive thing in the flow and the wall has not
//    changed;
//  - a successful commit must re-register the wall. The SW-07 registry keys every
//    spray cache on the version token, and this device is the one that moved it.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { COMMIT_SPRAY_WALL_VERSION, PROPOSE_SPRAY_WALL_RESET } from '@boardsesh/graphql/operations/spray-walls';

const requestMock = vi.hoisted(() => vi.fn());
const invalidateRenderDataMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../spray-wall-loader', () => ({ invalidateSprayWallRenderData: invalidateRenderDataMock }));

import { useCommitSprayWallVersion, useSprayWallResetProposal } from '../use-spray-wall-reset';

const WALL_UUID = '11111111-2222-3333-4444-555555555555';
const VERSION_ID = '42';
const LAYOUT_ID = 9001;

const DETECTIONS = [{ cx: 10, cy: 20, r: 5, outline: null }];

const PROPOSAL = {
  versionNumber: 2,
  kept: [{ holdId: 11, detectionIndex: 0, confidence: 0.9 }],
  removed: [12],
  added: [1],
  lowConfidence: [],
  climbsAffected: 3,
  movesSuggested: [],
  aspectMismatch: false,
};

const RESULT = {
  version: { id: VERSION_ID, number: 2 },
  keptCount: 1,
  removedCount: 1,
  addedCount: 1,
  climbsChanged: 3,
};

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, invalidateSpy };
}

beforeEach(() => {
  requestMock.mockReset();
  invalidateRenderDataMock.mockClear();
});

describe('useSprayWallResetProposal', () => {
  it('hands back what the reset would do', async () => {
    requestMock.mockResolvedValue({ proposeSprayWallReset: PROPOSAL });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useSprayWallResetProposal({ wallUuid: WALL_UUID, versionId: VERSION_ID, detections: DETECTIONS }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(PROPOSAL);
    expect(requestMock.mock.calls[0][0]).toBe(PROPOSE_SPRAY_WALL_RESET);
    expect(requestMock.mock.calls[0][1]).toEqual({
      input: { wallUuid: WALL_UUID, versionId: VERSION_ID, detections: DETECTIONS },
    });
  });

  it('surfaces a network failure instead of an empty proposal', async () => {
    // THE one that matters. A proposal that failed must not read as a proposal
    // with nothing in it: an empty `kept` and an empty `added` is the matcher
    // saying the whole wall has gone, and the screen would offer to commit it.
    requestMock.mockRejectedValue(new Error('Network request failed'));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useSprayWallResetProposal({ wallUuid: WALL_UUID, versionId: VERSION_ID, detections: DETECTIONS }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect((result.current.error as Error).message).toContain('Network request failed');
  });

  it('does not retry a failed proposal, and asks for nothing without an input', async () => {
    requestMock.mockRejectedValue(new Error('nope'));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useSprayWallResetProposal({ wallUuid: WALL_UUID, versionId: VERSION_ID, detections: DETECTIONS }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(requestMock).toHaveBeenCalledTimes(1);

    requestMock.mockClear();
    const { Wrapper: IdleWrapper } = makeWrapper();
    renderHook(() => useSprayWallResetProposal(null), { wrapper: IdleWrapper });
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('useCommitSprayWallVersion', () => {
  const input = { wallUuid: WALL_UUID, versionId: VERSION_ID, kept: [], removed: [12], added: [] };

  it('re-registers the wall and invalidates the climb queries once the reset lands', async () => {
    requestMock.mockResolvedValue({ commitSprayWallVersion: RESULT });
    const { Wrapper, invalidateSpy } = makeWrapper();

    const { result } = renderHook(() => useCommitSprayWallVersion(LAYOUT_ID), { wrapper: Wrapper });
    await result.current.mutateAsync(input);

    expect(requestMock.mock.calls[0][0]).toBe(COMMIT_SPRAY_WALL_VERSION);

    // The registry seam. Without it every spray cache key still names the
    // generation the owner was looking at when they pressed Confirm.
    await waitFor(() => expect(invalidateRenderDataMock).toHaveBeenCalledTimes(1));
    expect(invalidateRenderDataMock.mock.calls[0].slice(1)).toEqual([WALL_UUID, LAYOUT_ID]);

    // And every climb on the wall may have a different integrity number now.
    const invalidatedKeys = invalidateSpy.mock.calls.map(([options]) => options?.queryKey?.[0]);
    expect(invalidatedKeys).toContain('searchClimbs');
  });

  it('leaves the review intact when the commit is refused', async () => {
    // The wall has not changed, and the owner's verdicts on a hundred rings are
    // the expensive thing in the flow. A refused commit must be retryable from
    // exactly where they are — so it rejects, and invalidates nothing.
    requestMock.mockRejectedValue(new Error('SPRAY_WALL_VERSION_SUPERSEDED'));
    const { Wrapper, invalidateSpy } = makeWrapper();

    const { result } = renderHook(() => useCommitSprayWallVersion(LAYOUT_ID), { wrapper: Wrapper });
    await expect(result.current.mutateAsync(input)).rejects.toThrow('SPRAY_WALL_VERSION_SUPERSEDED');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateRenderDataMock).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('never retries a commit on its own', async () => {
    // A reset that appears to have failed may have landed. A silent second
    // attempt would be re-validated against a wall it has already changed.
    requestMock.mockRejectedValue(new Error('Network request failed'));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useCommitSprayWallVersion(LAYOUT_ID), { wrapper: Wrapper });
    await expect(result.current.mutateAsync(input)).rejects.toThrow();

    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
