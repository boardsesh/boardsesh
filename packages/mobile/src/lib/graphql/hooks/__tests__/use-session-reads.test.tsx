// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClientError, GraphQLClient } from 'graphql-request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_SESSION_DETAIL } from '@boardsesh/graphql/operations';
import { BOARD_LIVE_SESSIONS, FOLLOWED_LIVE_SESSIONS } from '@boardsesh/graphql/operations/live-sessions';
import type { LiveSession, SessionDetail } from '@boardsesh/shared-schema';
import { GET_SESSION, GET_SESSION_OWNER, type SessionPreview } from '../../operations';

const backend = vi.hoisted(() => ({
  client: undefined as GraphQLClient | undefined,
  getHttpClient: vi.fn(),
  getOfflineSyncHttpClient: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ focused: true, offline: false }));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    backend.getHttpClient();
    if (!backend.client) throw new Error('Owned native client missing');
    return backend.client;
  },
  getOfflineSyncHttpClient: () => {
    backend.getOfflineSyncHttpClient();
    throw new Error('Unexpected offline dispatch');
  },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => navigation.focused }));
vi.mock('../../../../hooks/use-is-offline', () => ({ useIsOffline: () => navigation.offline }));

import { useSessionDetail, useSessionOwnerUserId, useSessionPreview } from '../use-session-detail';
import { useBoardLiveSessions, useFollowedLiveSessions } from '../use-live-sessions';

const kinds = ['detail', 'preview', 'owner', 'followed', 'board'] as const;
type Kind = (typeof kinds)[number];
type LiveKind = 'followed' | 'board';
type Packet = { query: string; variables: Record<string, unknown> };
const documents = {
  detail: GET_SESSION_DETAIL,
  preview: GET_SESSION,
  owner: GET_SESSION_OWNER,
  followed: FOLLOWED_LIVE_SESSIONS,
  board: BOARD_LIVE_SESSIONS,
};
const sessionId = 'session-owned-by-another-climber';
const ownerUserId = 'creator-user-uuid';
const boardUuid = 'literal-board-link-uuid';
const startedAt = '2026-11-15T10:00:00.000Z';
const detail: SessionDetail = {
  sessionId,
  sessionType: 'party',
  sessionName: 'Sunday projects',
  ownerUserId,
  participants: [],
  totalSends: 1,
  totalFlashes: 0,
  totalAttempts: 0,
  tickCount: 1,
  gradeDistribution: [],
  boardTypes: ['tension'],
  firstTickAt: startedAt,
  lastTickAt: startedAt,
  ticks: [
    {
      uuid: 'tick-a',
      userId: ownerUserId,
      climbUuid: 'climb-a',
      climbName: 'Small edges',
      boardType: 'tension',
      angle: 40,
      status: 'send',
      attemptCount: 1,
      isMirror: false,
      isBenchmark: false,
      isNoMatch: false,
      climbedAt: startedAt,
      upvotes: 0,
      betaLinks: [],
    },
  ],
  upvotes: 0,
  downvotes: 0,
  voteScore: 0,
  commentCount: 0,
  healthKitWorkoutId: null,
};
const preview: SessionPreview = {
  id: sessionId,
  name: 'Sunday projects',
  boardPath: 'tension/10/20/30/40',
  color: null,
  goal: null,
  isPublic: true,
  isPermanent: false,
  startedAt,
  endedAt: null,
  users: [],
};

function liveSession(id: string, overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionId: id,
    name: 'Sunday projects',
    goal: null,
    color: null,
    startedAt,
    lastActivity: '2026-11-15T10:30:00.000Z',
    host: { userId: `host-${id}`, displayName: 'Hana Host', avatarUrl: null },
    participants: [{ userId: `guest-${id}`, displayName: 'Priya Nair', avatarUrl: null }],
    participantCount: 2,
    followedParticipantIds: [`guest-${id}`],
    viewerIsMember: false,
    isPublic: true,
    board: { uuid: boardUuid, name: 'Training wall', slug: 'training', boardType: 'tension', gymName: 'Local gym' },
    boardType: 'kilter',
    angle: 40,
    sendCount: 3,
    flashCount: 1,
    hardestSendGrade: '7A',
    currentClimb: { name: 'Small edges', grade: '6C' },
    reasons: ['FOLLOWING_USER'],
    ...overrides,
  };
}

function card(id: string) {
  return {
    sessionId: id,
    startedAtMs: Date.parse(startedAt),
    host: { userId: `host-${id}`, displayName: 'Hana Host', avatarUrl: null },
    participants: [{ userId: `guest-${id}`, displayName: 'Priya Nair', avatarUrl: null }],
    participantCount: 2,
    followedParticipantIds: [`guest-${id}`],
    viewerIsMember: false,
    boardName: 'Training wall',
    boardType: 'tension',
    gymName: 'Local gym',
    angle: 40,
    sendCount: 3,
    hardestSendGrade: '7A',
    currentClimbName: 'Small edges',
    currentClimbGrade: '6C',
    reasons: ['FOLLOWING_USER'],
  };
}

function key(kind: Kind, enabled = true) {
  switch (kind) {
    case 'detail':
      return ['sessionDetail', enabled ? sessionId : undefined];
    case 'preview':
      return ['sessionPreview', enabled ? sessionId : undefined];
    case 'owner':
      return ['sessionOwner', enabled ? sessionId : undefined];
    case 'followed':
      return ['liveSessions', 'followed', boardUuid];
    case 'board':
      return ['liveSessions', 'board', 42, boardUuid];
  }
}

function useRead(kind: Kind, enabled = true) {
  switch (kind) {
    case 'detail':
      return useSessionDetail(enabled ? sessionId : undefined);
    case 'preview':
      return useSessionPreview(enabled ? sessionId : undefined);
    case 'owner':
      return useSessionOwnerUserId(enabled ? sessionId : undefined);
    case 'followed':
      return useFollowedLiveSessions(boardUuid, enabled);
    case 'board':
      return useBoardLiveSessions(42, enabled, boardUuid);
  }
}

function useLiveRead(kind: LiveKind) {
  return kind === 'followed' ? useFollowedLiveSessions(boardUuid, true) : useBoardLiveSessions(42, true, boardUuid);
}

function storedAnswer(kind: Kind) {
  switch (kind) {
    case 'detail':
      return detail;
    case 'preview':
      return preview;
    case 'owner':
      return ownerUserId;
    case 'followed':
      return { followedLiveSessions: [liveSession('a')] };
    case 'board':
      return { boardLiveSessions: [liveSession('a')] };
  }
}

function publicAnswer(kind: Kind) {
  return kind === 'followed' || kind === 'board' ? [card('a')] : storedAnswer(kind);
}

let cache: QueryClient;
let packets: Packet[];
let refusalCount: number;
let returnNull: boolean;
let detailIsNull: boolean;
let creatorUserId: string | null;
let rows: LiveSession[];
let send: ReturnType<typeof vi.fn<(_url: unknown, options?: RequestInit) => Promise<Response>>>;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: cache }, children);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

beforeEach(() => {
  packets = [];
  refusalCount = 0;
  returnNull = false;
  detailIsNull = false;
  creatorUserId = ownerUserId;
  rows = [liveSession('a')];
  navigation.focused = true;
  navigation.offline = false;
  backend.getHttpClient.mockClear();
  backend.getOfflineSyncHttpClient.mockClear();
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } });
  send = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (typeof options?.body !== 'string') throw new Error('Expected actual SDK JSON request');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const packet = JSON.parse(options.body) as Packet;
    packets.push(packet);
    if (refusalCount > 0) {
      refusalCount -= 1;
      return Response.json({ errors: [{ message: 'Owned backend refusal' }] }, { status: 403 });
    }
    if (packet.query === GET_SESSION_DETAIL)
      return Response.json({ data: { sessionDetail: returnNull || detailIsNull ? null : detail } });
    if (packet.query === GET_SESSION) return Response.json({ data: { session: returnNull ? null : preview } });
    if (packet.query === GET_SESSION_OWNER) {
      return Response.json({
        data: { session: returnNull ? null : { id: sessionId, createdByUserId: creatorUserId } },
      });
    }
    if (packet.query === FOLLOWED_LIVE_SESSIONS) return Response.json({ data: { followedLiveSessions: rows } });
    if (packet.query === BOARD_LIVE_SESSIONS) return Response.json({ data: { boardLiveSessions: rows } });
    throw new Error('Unexpected GraphQL document');
  });
  backend.client = new GraphQLClient('https://native-session-owned.test/graphql', {
    fetch: (url, options) => send(url, options),
  });
});

afterEach(() => {
  cleanup();
  cache.clear();
  backend.client = undefined;
  expect(backend.getOfflineSyncHttpClient).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('session5 actual native/default adapter and installed SDK contracts', () => {
  it.each(kinds)(
    'preserves the %s document, literal key, public result and physical cache shape in one packet',
    async (kind) => {
      const { result } = renderHook(() => useRead(kind), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(packets).toHaveLength(1);
      expect(packets[0].query).toBe(documents[kind]);
      expect(packets[0].variables).toEqual(
        kind === 'followed' ? { boardUuid, limit: 12 } : kind === 'board' ? { boardId: 42, boardUuid } : { sessionId },
      );
      expect(
        cache
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toEqual([key(kind)]);
      expect(result.current.data).toEqual(publicAnswer(kind));
      expect(cache.getQueryData(key(kind))).toEqual(storedAnswer(kind));
      expect(backend.getHttpClient).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(kinds)(
    'keeps the existing same-native-owner %s cache readable while disabled without dispatch',
    async (kind) => {
      cache.setQueryData(key(kind, false), storedAnswer(kind));
      const { result } = renderHook(() => useRead(kind, false), { wrapper });
      expect(result.current.isSuccess).toBe(true);
      expect(result.current.data).toEqual(publicAnswer(kind));
      expect(cache.getQueryData(key(kind, false))).toEqual(storedAnswer(kind));
      await flush();
      expect(packets).toEqual([]);
      expect(backend.getHttpClient).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, ''])('does not send missing session targets (%s) or a missing board id', async (target) => {
    const { result } = renderHook(
      () => ({
        detail: useSessionDetail(target),
        preview: useSessionPreview(target),
        owner: useSessionOwnerUserId(target),
        board: useBoardLiveSessions(null, true, boardUuid),
      }),
      { wrapper },
    );
    await flush();
    expect(packets).toEqual([]);
    expect(Object.values(result.current).map((query) => query.fetchStatus)).toEqual(['idle', 'idle', 'idle', 'idle']);
    expect(
      cache
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([
      ['sessionDetail', target],
      ['sessionPreview', target],
      ['sessionOwner', target],
      ['liveSessions', 'board', null, boardUuid],
    ]);
  });

  it.each([null, '', boardUuid])(
    'accepts board id zero and preserves the optional UUID key/input semantics (%s)',
    async (uuid) => {
      const { result } = renderHook(() => useBoardLiveSessions(0, true, uuid), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(packets).toHaveLength(1);
      expect(packets[0].query).toBe(BOARD_LIVE_SESSIONS);
      expect(packets[0].variables).toEqual(uuid ? { boardId: 0, boardUuid: uuid } : { boardId: 0 });
      expect(
        cache
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toEqual([uuid ? ['liveSessions', 'board', 0, uuid] : ['liveSessions', 'board', 0]]);
    },
  );

  it.each([null, ''])('keeps the followed UUID literal in its key and request (%s)', async (uuid) => {
    const { result } = renderHook(() => useFollowedLiveSessions(uuid, true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(packets).toHaveLength(1);
    expect(packets[0].variables).toEqual({ boardUuid: uuid, limit: 12 });
    expect(
      cache
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([['liveSessions', 'followed', uuid]]);
  });

  it.each([ownerUserId, null])(
    'reuses an indefinitely old projected owner answer (%s) without sending on remount',
    async (cachedOwner) => {
      cache.setQueryData(['sessionOwner', sessionId], cachedOwner, {
        updatedAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
      });
      const first = renderHook(() => useSessionOwnerUserId(sessionId), { wrapper });
      expect(first.result.current.data).toBe(cachedOwner);
      await flush();
      first.unmount();
      const second = renderHook(() => useSessionOwnerUserId(sessionId), { wrapper });
      expect(second.result.current.data).toBe(cachedOwner);
      await flush();
      expect(packets).toEqual([]);
    },
  );

  it('retries owner exactly once and can recover the creator independently of detail', async () => {
    refusalCount = 1;
    const { result } = renderHook(() => useSessionOwnerUserId(sessionId), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(ownerUserId);
    expect(cache.getQueryData(['sessionOwner', sessionId])).toBe(ownerUserId);
    expect(packets).toHaveLength(2);
    expect(
      packets.every((packet) => packet.query === GET_SESSION_OWNER && packet.variables.sessionId === sessionId),
    ).toBe(true);
    expect(cache.getQueryData(['sessionDetail', sessionId])).toBeUndefined();
  });

  it('reads the creator of a zero-tick session while its detail is a successful null', async () => {
    detailIsNull = true;
    const { result } = renderHook(
      () => ({
        detail: useSessionDetail(sessionId),
        owner: useSessionOwnerUserId(sessionId),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.detail.isSuccess && result.current.owner.isSuccess).toBe(true));
    expect(result.current.detail.data).toBeNull();
    expect(result.current.owner.data).toBe(ownerUserId);
    expect(cache.getQueryData(['sessionDetail', sessionId])).toBeNull();
    expect(cache.getQueryData(['sessionOwner', sessionId])).toBe(ownerUserId);
    expect(packets.map((packet) => packet.query)).toEqual([GET_SESSION_DETAIL, GET_SESSION_OWNER]);
  });

  it.each(['detail', 'preview', 'owner'] as const)(
    'keeps an optional null %s answer as successful projected cache data',
    async (kind) => {
      returnNull = true;
      const { result } = renderHook(() => useRead(kind), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toBeNull();
      expect(cache.getQueryData(key(kind))).toBeNull();
      expect(result.current.error).toBeNull();
      expect(packets).toHaveLength(1);
    },
  );

  it('keeps a redacted creator scalar null even when the zero-tick session exists', async () => {
    creatorUserId = null;
    const { result } = renderHook(() => useSessionOwnerUserId(sessionId), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(cache.getQueryData(['sessionOwner', sessionId])).toBeNull();
    expect(packets).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(kinds)('preserves a real SDK %s error without manufacturing null or empty success', async (kind) => {
    refusalCount = 10;
    const { result } = renderHook(() => useRead(kind), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(cache.getQueryData(key(kind))).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(ClientError);
    expect(result.current.error?.message).toContain('Owned backend refusal');
    expect(packets).toHaveLength(kind === 'owner' ? 2 : 1);
  });

  it.each([
    { kind: 'detail' as const, age: 29_000, stale: false },
    { kind: 'detail' as const, age: 31_000, stale: true },
    { kind: 'preview' as const, age: 9_000, stale: false },
    { kind: 'preview' as const, age: 11_000, stale: true },
  ])('preserves $kind staleness for a cache age of $age milliseconds', async ({ kind, age, stale }) => {
    cache.setQueryData(key(kind), storedAnswer(kind), { updatedAt: Date.now() - age });
    const { result } = renderHook(() => useRead(kind), { wrapper });
    expect(result.current.data).toEqual(publicAnswer(kind));
    expect(result.current.isFetching).toBe(stale);
    if (stale) {
      await waitFor(() => expect(packets).toHaveLength(1));
      await waitFor(() => expect(result.current.isFetching).toBe(false));
    } else {
      await flush();
      expect(packets).toEqual([]);
    }
  });

  it('keeps stale followed cards while blurred and refetches immediately when Home returns', async () => {
    navigation.focused = false;
    rows = [];
    cache.setQueryData(['liveSessions', 'followed', boardUuid], storedAnswer('followed'), {
      updatedAt: Date.now() - 31_000,
    });
    const { result, rerender } = renderHook(() => useFollowedLiveSessions(boardUuid, true), { wrapper });
    expect(result.current.data).toEqual([card('a')]);
    await flush();
    expect(packets).toEqual([]);
    navigation.focused = true;
    rerender();
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(packets).toHaveLength(1);
    expect(cache.getQueryData(['liveSessions', 'followed', boardUuid])).toEqual({ followedLiveSessions: [] });
  });

  it.each(['followed', 'board'] as const)(
    'uses actual 60-second %s polling and stops it offline',
    async (kind: LiveKind) => {
      vi.useFakeTimers();
      const { result, rerender } = renderHook(() => useRead(kind), { wrapper });
      await advance(1);
      expect(result.current.isSuccess).toBe(true);
      expect(packets).toHaveLength(1);
      await advance(59_998);
      expect(packets).toHaveLength(1);
      await advance(2);
      expect(packets).toHaveLength(2);
      navigation.offline = true;
      rerender();
      await advance(120_000);
      expect(packets).toHaveLength(2);
      navigation.offline = false;
      rerender();
      await advance(59_999);
      expect(packets).toHaveLength(2);
      await advance(2);
      expect(packets).toHaveLength(3);
      navigation.focused = false;
      rerender();
      await advance(120_000);
      expect(packets).toHaveLength(kind === 'followed' ? 3 : 5);
      if (kind === 'followed') {
        navigation.focused = true;
        rerender();
        await advance(1);
        expect(packets).toHaveLength(4);
      }
    },
  );

  it.each(['followed', 'board'] as const)(
    'preserves %s card order and object identity across freshly decoded backend rows',
    async (kind: LiveKind) => {
      rows = [liveSession('a'), liveSession('b')];
      const { result } = renderHook(() => useLiveRead(kind), { wrapper });
      await waitFor(() => expect(result.current.data).toEqual([card('a'), card('b')]));
      const firstCards = result.current.data;
      rows = [liveSession('c'), liveSession('b'), liveSession('a', { lastActivity: '2026-11-15T10:45:00.000Z' })];
      await act(async () => {
        await result.current.refetch();
      });
      await waitFor(() => expect(result.current.data).toEqual([card('a'), card('b'), card('c')]));
      expect(result.current.data?.[0]).toBe(firstCards?.[0]);
      expect(result.current.data?.[1]).toBe(firstCards?.[1]);
      const cached = cache.getQueryData<{ followedLiveSessions?: LiveSession[]; boardLiveSessions?: LiveSession[] }>(
        key(kind),
      );
      expect(cached?.followedLiveSessions ?? cached?.boardLiveSessions).toEqual(rows);
      expect(cached?.followedLiveSessions?.[2] ?? cached?.boardLiveSessions?.[2]).not.toBe(rows[2]);
      rows = [liveSession('c'), liveSession('own', { viewerIsMember: true }), liveSession('a')];
      await act(async () => {
        await result.current.refetch();
      });
      await waitFor(() => expect(result.current.data?.map((entry) => entry.sessionId)).toEqual(['own', 'a', 'c']));
      expect(packets).toHaveLength(3);
    },
  );
});
