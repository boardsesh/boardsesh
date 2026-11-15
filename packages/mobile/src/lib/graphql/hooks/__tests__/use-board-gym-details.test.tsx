// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GraphQLClient } from 'graphql-request';
import { GET_GYM, GET_MY_GYMS } from '@boardsesh/graphql/operations/gyms';
import { GET_BOARD_BY_SLUG } from '@boardsesh/graphql/operations/boards';
import { GET_BOARD, GET_POPULAR_BOARD_CONFIGS } from '../../operations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ client: undefined as GraphQLClient | undefined }));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    if (!backend.client) throw new Error('Owned native client missing');
    return backend.client;
  },
  getOfflineSyncHttpClient: () => {
    throw new Error('Unexpected offline dispatch');
  },
}));
import { useBoard, useGym, useMyGyms, useBoardBySlug, usePopularBoardConfigs } from '../use-board-gym-details';
const kinds = ['board', 'gym', 'myGyms', 'slug', 'popular'] as const;
type Kind = (typeof kinds)[number];
const documents = {
  board: GET_BOARD,
  gym: GET_GYM,
  myGyms: GET_MY_GYMS,
  slug: GET_BOARD_BY_SLUG,
  popular: GET_POPULAR_BOARD_CONFIGS,
};
let refuse: boolean;
const input = { boardType: 'tension' as const, limit: 12, offset: 7 };
const target = 'resource-owned-by-someone-else';
let cache: QueryClient;
let packets: { query: string; variables: unknown }[];
let send: ReturnType<typeof vi.fn<(_url: unknown, options?: RequestInit) => Promise<Response>>>;
const entities = {
  board: { uuid: target, ownerId: 'other-person', canEdit: true },
  gym: { uuid: target, ownerId: 'other-person', canEdit: true },
  boardBySlug: { uuid: target, slug: target, ownerId: 'other-person', canEdit: true },
  myGyms: { gyms: [{ uuid: target }], totalCount: 80, hasMore: true },
  popularBoardConfigs: { configs: [{ boardType: 'tension' }], totalCount: 50, hasMore: true },
};
function key(kind: Kind, enabled = true) {
  switch (kind) {
    case 'board':
      return ['board', enabled ? target : null];
    case 'gym':
      return ['gym', enabled ? target : null];
    case 'myGyms':
      return ['myGyms'];
    case 'slug':
      return ['boardBySlug', target];
    case 'popular':
      return ['popularBoardConfigs', input];
  }
}
function useRead(kind: Kind, enabled = true) {
  switch (kind) {
    case 'board':
      return useBoard(enabled ? target : null);
    case 'gym':
      return useGym(enabled ? target : null);
    case 'myGyms':
      return useMyGyms({ enabled });
    case 'slug':
      return useBoardBySlug(target, { enabled });
    case 'popular':
      return usePopularBoardConfigs(input, { enabled });
  }
}
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: cache }, children);
}
beforeEach(() => {
  packets = [];
  refuse = false;
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  send = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (typeof options?.body !== 'string') throw new Error('Expected actual SDK JSON request');
    const payload = JSON.parse(options.body) as { query: string; variables: unknown };
    packets.push(payload);
    if (refuse) return Response.json({ errors: [{ message: 'Owned backend refusal' }] }, { status: 403 });
    return Response.json({ data: entities });
  });
  backend.client = new GraphQLClient('https://native-owned.test/graphql', {
    fetch: (url, options) => send(url, options),
  });
});
afterEach(() => {
  cleanup();
  cache.clear();
  backend.client = undefined;
  vi.restoreAllMocks();
});
describe('finite5 actual native/default adapter and installed SDK parity', () => {
  it.each(kinds)('keeps the %s logical key, one SDK packet and selected result', async (kind) => {
    const { result } = renderHook(() => useRead(kind), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(packets).toHaveLength(1);
    expect(packets[0].query).toBe(documents[kind]);
    expect(
      cache
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([key(kind)]);
    const field = kind === 'slug' ? 'boardBySlug' : kind === 'popular' ? 'popularBoardConfigs' : kind;
    expect(result.current.data).toEqual(entities[field]);
    expect(cache.getQueryData(key(kind))).toEqual(entities);
    expect(packets[0].variables).toEqual(
      kind === 'board'
        ? { boardUuid: target }
        : kind === 'gym'
          ? { gymUuid: target }
          : kind === 'slug'
            ? { slug: target }
            : kind === 'myGyms'
              ? { input: { limit: 50 } }
              : { input },
    );
  });
  it.each(kinds)('retains cached %s while disabled without any packet', async (kind) => {
    cache.setQueryData(key(kind, false), entities);
    const { result } = renderHook(() => useRead(kind, false), { wrapper });
    expect(result.current.isSuccess).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(packets).toEqual([]);
    expect(result.current.data).toEqual(
      entities[kind === 'slug' ? 'boardBySlug' : kind === 'popular' ? 'popularBoardConfigs' : kind],
    );
  });
  it('retains one-hour popular configuration reuse and literal raw invalidation', async () => {
    cache.setQueryData(key('popular'), entities, { updatedAt: Date.now() - 30 * 60 * 1000 });
    const { result } = renderHook(() => useRead('popular'), { wrapper });
    expect(result.current.isSuccess).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(packets).toEqual([]);
    await act(async () => {
      await cache.invalidateQueries({ queryKey: ['popularBoardConfigs'] });
    });
    expect(packets).toHaveLength(1);
  });
  it('does not page the 50-row own-gym response merely because hasMore is true', async () => {
    const { result } = renderHook(() => useMyGyms(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(packets).toHaveLength(1);
    expect(packets[0].variables).toEqual({ input: { limit: 50 } });
  });
  it('preserves null, undefined input and optional enabled defaults', async () => {
    const { result } = renderHook(
      () => ({
        board: useBoard(null),
        gym: useGym(null),
        slug: useBoardBySlug(null),
        popular: usePopularBoardConfigs(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.popular.isSuccess).toBe(true));
    expect(packets).toHaveLength(1);
    expect(packets[0].variables).toEqual({});
    expect(result.current.board.fetchStatus).toBe('idle');
    expect(result.current.gym.fetchStatus).toBe('idle');
    expect(result.current.slug.fetchStatus).toBe('idle');
  });
  it('keeps a genuine SDK error and does not manufacture a null success', async () => {
    refuse = true;
    const { result } = renderHook(() => useGym(target), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(packets).toHaveLength(1);
  });
});
