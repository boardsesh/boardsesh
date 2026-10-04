// @vitest-environment jsdom
// useClimbLogs and useClimbLogsPreview read everyone's logs on a climb. These
// pin what the list relies on: the filters go to the server, one page per
// request, a key per filter set and per viewer, network only, and an older
// server reads as "no rows" rather than as a broken sheet.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_CLIMB_LOGS } from '@boardsesh/graphql/operations';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  offlineAwareRequest: vi.fn(),
  viewerId: 'viewer' as string | undefined,
}));

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../offline-request', () => ({ offlineAwareRequest: mocks.offlineAwareRequest }));
vi.mock('../../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: mocks.viewerId, isLoading: false }),
}));

import { flattenClimbLogPages, useClimbLogs, useClimbLogsPreview } from '../use-climb-logs';
import {
  CLIMB_LOGS_PREVIEW_QUERY_KEY,
  CLIMB_LOGS_QUERY_KEY,
  climbLogsPreviewQueryKey,
  climbLogsQueryKey,
} from '../../query-keys';

type Page = { items: Array<{ uuid: string }>; cursor: string | null; hasMore: boolean };
const page = (uuids: string[], cursor: string | null = null): { climbLogs: Page } => ({
  climbLogs: { items: uuids.map((uuid) => ({ uuid })), cursor, hasMore: cursor !== null },
});

function createHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

const ALL_OFF = { withNotes: false, sendsOnly: false, excludeFollowed: true };
const listArgs = (overrides: Partial<Parameters<typeof useClimbLogs>[0]> = {}) => ({
  boardName: 'kilter',
  climbUuid: 'c1' as string | null,
  ...ALL_OFF,
  enabled: true,
  ...overrides,
});

async function expectNoRequest() {
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mocks.request).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewerId = 'viewer';
  mocks.request.mockResolvedValue(page(['log-1']));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('climb logs query keys', () => {
  it('have bare string roots, like the other follow-scoped keys', () => {
    expect(CLIMB_LOGS_QUERY_KEY).toBe('climbLogs');
    expect(CLIMB_LOGS_PREVIEW_QUERY_KEY).toBe('climbLogsPreview');
  });

  it('carry the viewer, the climb and everything the server filters on', () => {
    expect(
      climbLogsQueryKey('viewer', 'kilter', 'c1', {
        angle: 40,
        withNotes: true,
        sendsOnly: false,
        excludeFollowed: true,
      }),
    ).toEqual(['climbLogs', 'viewer', 'kilter', 'c1', 40, true, false, true]);
    expect(
      climbLogsQueryKey('viewer', 'kilter', 'c1', {
        angle: undefined,
        withNotes: false,
        sendsOnly: false,
        excludeFollowed: false,
      }),
    ).toEqual(['climbLogs', 'viewer', 'kilter', 'c1', null, false, false, false]);
  });

  it('give the preview no angle, so turning the board refetches nothing', () => {
    expect(climbLogsPreviewQueryKey('viewer', 'kilter', 'c1')).toEqual(['climbLogsPreview', 'viewer', 'kilter', 'c1']);
  });

  it.each([
    ['the viewer', ['other', 'kilter', 'c1', { angle: 40, ...ALL_OFF }]],
    ['the board', ['viewer', 'tension', 'c1', { angle: 40, ...ALL_OFF }]],
    ['the climb', ['viewer', 'kilter', 'c2', { angle: 40, ...ALL_OFF }]],
    ['the angle', ['viewer', 'kilter', 'c1', { angle: 45, ...ALL_OFF }]],
    ['no angle', ['viewer', 'kilter', 'c1', { angle: undefined, ...ALL_OFF }]],
    ['with notes', ['viewer', 'kilter', 'c1', { angle: 40, ...ALL_OFF, withNotes: true }]],
    ['sends only', ['viewer', 'kilter', 'c1', { angle: 40, ...ALL_OFF, sendsOnly: true }]],
    ['keeping followed climbers', ['viewer', 'kilter', 'c1', { angle: 40, ...ALL_OFF, excludeFollowed: false }]],
  ] as Array<[string, Parameters<typeof climbLogsQueryKey>]>)('change with %s', (_label, args) => {
    const base = climbLogsQueryKey('viewer', 'kilter', 'c1', { angle: 40, ...ALL_OFF });
    expect(climbLogsQueryKey(...args)).not.toEqual(base);
  });
});

describe('useClimbLogs', () => {
  it('asks the server directly for one row per climber, a page of 20', async () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogs(listArgs({ angle: 40, withNotes: true })), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith(GET_CLIMB_LOGS, {
      input: {
        boardType: 'kilter',
        climbUuid: 'c1',
        angle: 40,
        withNotes: true,
        sendsOnly: false,
        excludeFollowed: true,
        latestPerClimber: true,
        limit: 20,
        cursor: null,
      },
    });
    // Never the offline interceptor: there is no local copy of these logs to read.
    expect(mocks.offlineAwareRequest).not.toHaveBeenCalled();
  });

  it('leaves the angle out of the request when every angle is wanted', async () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogs(listArgs({ excludeFollowed: false })), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    const { input } = mocks.request.mock.calls[0][1] as { input: Record<string, unknown> };
    expect('angle' in input).toBe(false);
    expect(input.excludeFollowed).toBe(false);
  });

  it('pages with the cursor the server handed back, one page per call', async () => {
    mocks.request.mockResolvedValueOnce(page(['log-1', 'log-2'], 'cursor-1')).mockResolvedValueOnce(page(['log-3']));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogs(listArgs()), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect((mocks.request.mock.calls[1][1] as { input: { cursor: string } }).input.cursor).toBe('cursor-1');
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(flattenClimbLogPages(result.current.data?.pages).map((log) => log.uuid)).toEqual([
      'log-1',
      'log-2',
      'log-3',
    ]);
  });

  it('has no next page when the server says there is none, whatever cursor it sent', async () => {
    mocks.request.mockResolvedValue({ climbLogs: { items: [{ uuid: 'log-1' }], cursor: 'stray', hasMore: false } });
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogs(listArgs()), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.hasNextPage).toBe(false);
  });

  it('stops at one page in screenshot mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    mocks.request.mockResolvedValue(page(['log-1'], 'cursor-1'));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogs(listArgs()), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.hasNextPage).toBe(false);
  });

  it.each([
    ['the caller turns it off', { enabled: false }, 'viewer'],
    ['there is no climb', { climbUuid: null }, 'viewer'],
    ['there is no viewer id', {}, undefined],
  ] as const)('stays silent when %s', async (_label, overrides, viewerId) => {
    mocks.viewerId = viewerId;
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogs(listArgs(overrides)), { wrapper });

    await expectNoRequest();
    // A disabled query is `pending` forever, so "loading" has to come from `isLoading`.
    expect(result.current.isLoading).toBe(false);
  });

  it('reads a server that does not know the field as no rows, not as an error', async () => {
    mocks.request.mockRejectedValue(new Error('Cannot query field "climbLogs" on type "Query".'));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogs(listArgs()), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages).toEqual([{ items: [], cursor: null, hasMore: false }]);
    expect(result.current.hasNextPage).toBe(false);
  });

  it('lets every other failure through', async () => {
    mocks.request.mockRejectedValue(new Error('Network request failed'));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogs(listArgs()), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useClimbLogsPreview', () => {
  const previewArgs = { boardName: 'kilter', climbUuid: 'c1', enabled: true };

  it('asks for the newest six from everyone else, at every angle', async () => {
    mocks.request.mockResolvedValue(page(['log-1', 'log-2']));
    const { client, wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogsPreview(previewArgs), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.map((log) => log.uuid)).toEqual(['log-1', 'log-2']);
    expect(mocks.request).toHaveBeenCalledWith(GET_CLIMB_LOGS, {
      input: { boardType: 'kilter', climbUuid: 'c1', excludeFollowed: true, latestPerClimber: true, limit: 6 },
    });
    expect(mocks.offlineAwareRequest).not.toHaveBeenCalled();
    expect(client.getQueryData(['climbLogsPreview', 'viewer', 'kilter', 'c1'])).toBeDefined();
  });

  it('stays silent in screenshot mode, so store captures need no recording for it', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    const { wrapper } = createHarness();
    renderHook(() => useClimbLogsPreview(previewArgs), { wrapper });
    await expectNoRequest();
  });

  it.each([
    ['the caller turns it off', { enabled: false }, 'viewer'],
    ['there is no climb', { climbUuid: null }, 'viewer'],
    ['there is no viewer id', {}, undefined],
  ] as const)('stays silent when %s', async (_label, overrides, viewerId) => {
    mocks.viewerId = viewerId;
    const { wrapper } = createHarness();
    renderHook(() => useClimbLogsPreview({ ...previewArgs, ...overrides }), { wrapper });
    await expectNoRequest();
  });

  it('reads a server that does not know the field as no rows', async () => {
    mocks.request.mockRejectedValue(new Error('Cannot query field "climbLogs" on type "Query".'));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useClimbLogsPreview(previewArgs), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe('flattenClimbLogPages', () => {
  const pageOf = (uuids: string[]) =>
    page(uuids).climbLogs as Parameters<typeof flattenClimbLogPages>[0] extends readonly (infer TPage)[] | undefined
      ? TPage
      : never;

  it('joins the pages in order', () => {
    expect(flattenClimbLogPages([pageOf(['a', 'b']), pageOf(['c'])]).map((log) => log.uuid)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a log that shows up on two pages once, where it first appeared', () => {
    expect(flattenClimbLogPages([pageOf(['a', 'b']), pageOf(['b', 'c'])]).map((log) => log.uuid)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('is empty before the first page lands', () => {
    expect(flattenClimbLogPages(undefined)).toEqual([]);
  });
});
