import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  requestSearchBoards,
  shouldRetryBoardSearch,
  boardSearchRetryDelay,
  resetBoardSearchCooldownForTests,
} from '../search-boards-request';
import { SEARCH_BOARDS } from '@boardsesh/graphql/operations';
import { reportHandledError } from '../../error-reporting';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));

const EMPTY_BOARDS = { searchBoards: { boards: [], totalCount: 0, hasMore: false } };
function throttle(seconds: unknown = 11) {
  return Object.assign(new Error('Rate limited'), {
    response: {
      status: 200,
      errors: [{ extensions: { code: 'RATE_LIMITED', operation: 'searchBoards', retryAfterSeconds: seconds } }],
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.clearAllMocks();
  requestMock.mockReset();
  resetBoardSearchCooldownForTests();
});
afterEach(() => vi.useRealTimers());

describe('board search server cooldown', () => {
  it('passes the abort signal and leaves the response unchanged', async () => {
    requestMock.mockResolvedValueOnce(EMPTY_BOARDS);
    const signal = new AbortController().signal;
    await expect(requestSearchBoards({ boardTypes: ['kilter'] }, signal)).resolves.toBe(EMPTY_BOARDS);
    expect(requestMock).toHaveBeenCalledWith({
      document: SEARCH_BOARDS,
      variables: { input: { boardTypes: ['kilter'] } },
      signal,
    });
  });

  it('blocks a changed filter until the 11-second server deadline plus buffer', async () => {
    const error = throttle();
    requestMock.mockRejectedValueOnce(error).mockResolvedValueOnce(EMPTY_BOARDS);
    await expect(requestSearchBoards({}, new AbortController().signal)).rejects.toBe(error);
    const next = requestSearchBoards({ boardTypes: ['tension'] }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(11_249);
    expect(requestMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toBe(EMPTY_BOARDS);
    expect(requestMock.mock.calls[1]?.[0].variables.input).toEqual({ boardTypes: ['tension'] });
    expect(reportHandledError).toHaveBeenCalledOnce();
  });

  it('abandons an obsolete search during cooldown', async () => {
    requestMock.mockRejectedValueOnce(throttle()).mockResolvedValueOnce(EMPTY_BOARDS);
    await expect(requestSearchBoards({}, new AbortController().signal)).rejects.toThrow();
    const obsolete = new AbortController();
    const old = requestSearchBoards({ query: 'old' }, obsolete.signal);
    const rejection = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    obsolete.abort();
    await rejection;
    const latest = requestSearchBoards({ query: 'latest' }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(11_250);
    await latest;
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[1]?.[0].variables.input.query).toBe('latest');
  });

  it('rechecks the deadline if a concurrent response extends it', async () => {
    let rejectConcurrent: (error: unknown) => void = () => undefined;
    requestMock
      .mockRejectedValueOnce(throttle(2))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectConcurrent = reject;
          }),
      )
      .mockResolvedValueOnce(EMPTY_BOARDS);
    const first = requestSearchBoards({}, new AbortController().signal);
    const concurrent = requestSearchBoards({ query: 'concurrent' }, new AbortController().signal);
    await expect(first).rejects.toThrow();
    const concurrentRejection = expect(concurrent).rejects.toThrow();
    const waiting = requestSearchBoards({ query: 'waiting' }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    rejectConcurrent(throttle(11));
    await concurrentRejection;
    await vi.advanceTimersByTimeAsync(11_249);
    expect(requestMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe(EMPTY_BOARDS);
  });

  it.each([undefined, null, -1, NaN, Infinity, '11'])(
    'uses the 60-second window for invalid/missing delay %s',
    async (seconds) => {
      const error = throttle(seconds);
      // Calling with undefined uses the fixture's default, so explicitly replace it.
      error.response.errors[0]!.extensions.retryAfterSeconds = seconds;
      requestMock.mockRejectedValueOnce(error).mockResolvedValueOnce(EMPTY_BOARDS);
      await expect(requestSearchBoards({}, new AbortController().signal)).rejects.toThrow();
      const next = requestSearchBoards({}, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(60_249);
      expect(requestMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await next;
    },
  );

  it('does not clamp a valid server wait to 30 seconds', () => {
    expect(boardSearchRetryDelay(0, throttle(45))).toBe(45_250);
    expect(boardSearchRetryDelay(0, throttle(0))).toBe(250);
  });

  it('does not send an already aborted query or report ordinary errors early', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(requestSearchBoards({}, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestMock).not.toHaveBeenCalled();
    const ordinary = new Error('broken');
    requestMock.mockRejectedValueOnce(ordinary).mockResolvedValueOnce(EMPTY_BOARDS);
    await expect(requestSearchBoards({}, new AbortController().signal)).rejects.toBe(ordinary);
    await requestSearchBoards({}, new AbortController().signal);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('query observer recovery and cancellation', () => {
  function observe() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const observer = new QueryObserver(queryClient, {
      queryKey: ['nearbyBoards', 'first'],
      queryFn: ({ signal }) => requestSearchBoards({ query: 'first' }, signal),
      retry: shouldRetryBoardSearch,
      retryDelay: boardSearchRetryDelay,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    return { queryClient, observer, unsubscribe };
  }

  it('automatically recovers and cancels the old retry when the key changes', async () => {
    requestMock.mockRejectedValueOnce(throttle()).mockResolvedValueOnce(EMPTY_BOARDS);
    const { queryClient, observer, unsubscribe } = observe();
    await vi.advanceTimersByTimeAsync(0);
    observer.setOptions({
      queryKey: ['nearbyBoards', 'latest'],
      queryFn: ({ signal }) => requestSearchBoards({ query: 'latest' }, signal),
      retry: shouldRetryBoardSearch,
      retryDelay: boardSearchRetryDelay,
    });
    await vi.advanceTimersByTimeAsync(11_249);
    expect(requestMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[1]?.[0].variables.input.query).toBe('latest');
    expect(observer.getCurrentResult().isSuccess).toBe(true);
    expect(queryClient.getQueryData(['nearbyBoards', 'first'])).toBeUndefined();
    unsubscribe();
    queryClient.clear();
  });

  it('stops after two rate-limit retries and preserves the error', async () => {
    const error = throttle();
    requestMock.mockRejectedValue(error);
    const { queryClient, observer, unsubscribe } = observe();
    await vi.advanceTimersByTimeAsync(22_500);
    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(observer.getCurrentResult().error).toBe(error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestMock).toHaveBeenCalledTimes(3);
    unsubscribe();
    queryClient.clear();
  });

  it('unmounts safely while a retry is delayed', async () => {
    requestMock.mockRejectedValueOnce(throttle());
    const { queryClient, unsubscribe } = observe();
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(11_250);
    expect(requestMock).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it('preserves default nonthrottle retry exclusions', () => {
    for (const error of [
      { response: { errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] } },
      { name: 'BackendUnavailableError' },
      { code: 'GRAPHQL_REQUEST_TIMEOUT' },
    ])
      expect(shouldRetryBoardSearch(0, error)).toBe(false);
    expect(shouldRetryBoardSearch(0, new Error('ordinary'))).toBe(true);
    expect(shouldRetryBoardSearch(2, new Error('ordinary'))).toBe(false);
  });
});
