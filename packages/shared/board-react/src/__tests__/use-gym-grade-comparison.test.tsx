// @vitest-environment happy-dom
import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  GET_GYM_GRADE_COLLECTION_OPTIONS,
  GET_GYM_GRADE_COMPARISON,
  GYM_REPORTING_RECEIPT_MS,
  GymReportingViewerChangedError,
  gymReportingQueryKey,
} from '@boardsesh/graphql';
import type { GymGradeComparison } from '@boardsesh/shared-schema';
import {
  gymGradeComparisonQueryKey,
  useGymGradeCollectionPicker,
  useGymGradeComparison,
  type GymGradeRequest,
} from '../use-gym-grade-comparison';

const report = {
  gymUuid: 'gym',
  asOf: '2026-11-23T10:00:00.000000Z',
  startAt: '2026-11-16T10:00:00.000000Z',
  timeZone: 'UTC',
  availableCount: 1,
  sendCount: 0,
  grades: [],
  boards: [],
} satisfies GymGradeComparison;

afterEach(() => {
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

function harness(request: GymGradeRequest) {
  const client = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ viewer }: { viewer: string }) =>
      useGymGradeComparison({ viewerId: viewer, gymUuid: 'gym', request }, null, 'week'),
    { wrapper, initialProps: { viewer: 'viewer' } },
  );
}

describe('private grade comparison receipts', () => {
  it('retires a grade snapshot at five minutes and a failed refresh does not renew it', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<GymGradeRequest>()
      .mockResolvedValueOnce({ gymGradeComparison: report })
      .mockRejectedValue(new Error('denied'));
    const result = harness(request as unknown as GymGradeRequest);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.result.current.data).toEqual(report);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GYM_REPORTING_RECEIPT_MS);
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.result.current.data).toBeUndefined();
    result.unmount();
  });

  it('hides the private payload immediately after going offline or changing viewer', async () => {
    vi.useFakeTimers();
    const request = vi.fn<GymGradeRequest>().mockResolvedValueOnce({ gymGradeComparison: report });
    const result = harness(request as unknown as GymGradeRequest);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.result.current.data).toEqual(report);
    act(() => onlineManager.setOnline(false));
    expect(result.result.current.data).toBeUndefined();
    result.rerender({ viewer: 'another-viewer' });
    expect(result.result.current.data).toBeUndefined();
    result.unmount();
  });
});

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('shared comparison and picker access', () => {
  it.each([
    ['picker search', { response: { errors: [{ extensions: { code: 'FORBIDDEN' } }] } }],
    ['picker save', { response: { status: 401 } }],
    ['picker save', { response: { status: 403 } }],
    ['picker save', new GymReportingViewerChangedError()],
  ] as const)('retire all current receipts after a denied %s', async (operation, denial) => {
    const client = new QueryClient();
    const overviewKey = gymReportingQueryKey('viewer', 'old-gym', null, 'week');
    const comparisonKey = gymGradeComparisonQueryKey('viewer', { gymUuid: 'gym', boardUuid: null, period: 'week' });
    client.setQueryData(overviewKey, { privateOverview: true });
    const deniedRequest = deferred<never>();
    const lateComparison = deferred<{ gymGradeComparison: GymGradeComparison }>();
    let comparisonSignal: AbortSignal | undefined;
    let compareReads = 0;
    let pickerReads = 0;

    const transport = vi.fn((document: string, _variables: object, signal?: AbortSignal) => {
      if (document === GET_GYM_GRADE_COMPARISON) {
        if (++compareReads > 1) {
          comparisonSignal = signal;
          return lateComparison.promise;
        }
        return Promise.resolve({ gymGradeComparison: report });
      }
      if (document === GET_GYM_GRADE_COLLECTION_OPTIONS && ++pickerReads === 1) {
        return Promise.resolve({
          gymGradeCollectionOptions: { collections: [{ uuid: 'private', name: 'Staff playlist' }], nextCursor: null },
        });
      }
      return deniedRequest.promise;
    });
    // The real transport response type is determined by the operation document.
    const request = transport as unknown as GymGradeRequest;
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(
      () => {
        const requestScope = { viewerId: 'viewer', gymUuid: 'gym', overviewGymUuid: 'old-gym', request };
        const reportRead = useGymGradeComparison(requestScope, null, 'week');
        const picker = useGymGradeCollectionPicker(requestScope, 'board');
        return { reportRead, picker };
      },
      { wrapper },
    );

    await waitFor(() => expect(result.current.reportRead.data).toEqual(report));
    await waitFor(() => expect(result.current.picker.data?.collections[0]?.name).toBe('Staff playlist'));
    // The comparison still holds the previous successful payload in its cache
    // while its latest authorized response is in flight.
    act(() => result.current.reportRead.retry());
    await waitFor(() => expect(comparisonSignal).toBeDefined());
    expect(client.getQueryData(comparisonKey)).toEqual(report);
    if (operation === 'picker search') {
      act(() => result.current.picker.setSearch('second'));
      act(() => result.current.picker.searchNow());
    } else {
      act(() => {
        void result.current.picker.save('private').catch(() => undefined);
      });
    }
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(4));
    await act(async () => deniedRequest.reject(denial));
    await waitFor(() => expect(result.current.reportRead.state).toBe('denied'));
    expect(result.current.reportRead.data).toBeUndefined();
    expect(result.current.picker.data).toBeUndefined();
    expect(client.getQueryData(overviewKey)).toBeUndefined();
    expect(client.getQueryData(comparisonKey)).toBeUndefined();
    expect(comparisonSignal?.aborted).toBe(true);

    await act(async () => lateComparison.resolve({ gymGradeComparison: report }));
    expect(result.current.reportRead.state).toBe('denied');
    expect(client.getQueryData(comparisonKey)).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(4);
    unmount();
  });
});
