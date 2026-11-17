// @vitest-environment jsdom
/**
 * Board and gym reads outlive their screen on phones (#7596 A4, the revert of
 * #7559). useBoard, useBoardBySlug, useGym, useMyGyms and usePopularBoardConfigs
 * are plain useQuery reads again: they never read TanStack's abort signal, so a
 * board sheet or gym page closed mid-fetch still fills the cache for the next
 * visit instead of cancelling the request.
 *
 * Real HTTP through a local node:http server; see helpers/held-graphql-server.
 */
import type { GraphQLClient } from 'graphql-request';
import { afterAll, afterEach, beforeAll, describe, it, vi } from 'vitest';
import {
  createHeldGraphQLServer,
  expectReadOutlivesScreen,
  type ReadCase,
} from '../../__tests__/helpers/held-graphql-server';

const transport = vi.hoisted(() => ({ client: null as GraphQLClient | null }));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    if (!transport.client) throw new Error('The local GraphQL server has not started');
    return transport.client;
  },
}));
// These reads live in the hooks barrel. It re-exports siblings that reach
// react-native, expo and the native credential store. None of them is on the
// path of the five reads below; they are stubbed only so the barrel loads.
vi.mock('react-native', () => ({}));
vi.mock('../../../auth-store', () => ({
  getAuthToken: async () => null,
  captureAuthCredentialGeneration: () => 1,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../use-similar-climbs', () => ({ useSimilarClimbs: vi.fn() }));
vi.mock('../use-mobile-climb-actions-data', () => ({ useMobileClimbActionsData: vi.fn() }));
vi.mock('../use-you-profile-data', () => ({}));
vi.mock('../use-integrations', () => ({}));

import { useBoard, useBoardBySlug, useGym, useMyGyms, usePopularBoardConfigs } from '../index';

const server = createHeldGraphQLServer();

beforeAll(async () => {
  transport.client = await server.start();
});

afterEach(() => {
  server.releaseAll();
});

afterAll(async () => {
  transport.client = null;
  await server.stop();
});

const READS: ReadCase[] = [
  {
    name: 'board',
    operationName: 'GetBoard',
    queryKey: ['board', 'board-1'],
    data: { board: null },
    mount: () => useBoard('board-1'),
  },
  {
    name: 'board by slug',
    operationName: 'GetBoardBySlug',
    queryKey: ['boardBySlug', 'home-wall'],
    data: { boardBySlug: null },
    mount: () => useBoardBySlug('home-wall'),
  },
  {
    name: 'gym',
    operationName: 'GetGym',
    queryKey: ['gym', 'gym-1'],
    data: { gym: null },
    mount: () => useGym('gym-1'),
  },
  {
    name: 'my gyms',
    operationName: 'GetMyGyms',
    queryKey: ['myGyms'],
    data: { myGyms: { gyms: [], totalCount: 0, hasMore: false } },
    mount: () => useMyGyms(),
  },
  {
    name: 'popular board configs',
    operationName: 'GetPopularBoardConfigs',
    queryKey: ['popularBoardConfigs', undefined],
    data: { popularBoardConfigs: { configs: [], totalCount: 0, hasMore: false } },
    mount: () => usePopularBoardConfigs(),
  },
];

describe('native board and gym reads outlive the screen that started them', () => {
  it.each(READS)('$name: the answer lands in the cache after the screen unmounts', async (read) => {
    await expectReadOutlivesScreen(server, read);
  });
});
