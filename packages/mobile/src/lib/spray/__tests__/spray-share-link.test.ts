import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { parse, validate, buildSchema } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import { GET_SPRAY_WALL_FOR_LINK } from '@boardsesh/graphql/operations/spray-walls';

const request = vi.hoisted(() => vi.fn());
const credentials = vi.hoisted(() => ({ generation: 0 }));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../auth-store', () => ({
  captureAuthCredentialGeneration: () => credentials.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === credentials.generation,
}));

import { fetchSprayWallBoardFromLink } from '../spray-wall-link-board';
import { sprayWallByLayoutQueryKey } from '../spray-wall-loader';
import { isWallUuidParam } from '../use-spray-wall-link';
import {
  clearSprayWallRegistry,
  getSprayWallLoadState,
  setSprayWallLoader,
  unregisterSprayWall,
} from '../spray-wall-registry';

const WALL_UUID = '11111111-2222-3333-4444-555555555555';
const WALL_SLUG = 'crew-wall';
const wall = {
  uuid: WALL_UUID,
  layoutId: 4242,
  board: { uuid: WALL_UUID, slug: WALL_SLUG, boardType: 'spray', layoutId: 4242, isOwned: false, canEdit: false },
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  request.mockReset();
  credentials.generation = 0;
  clearSprayWallRegistry();
  setSprayWallLoader(null);
});

describe('shared-wall capability resolution', () => {
  it('returns the authorized board and seeds only its render identity', async () => {
    request.mockResolvedValue({ sprayWall: wall });
    const queryClient = makeQueryClient();
    await expect(fetchSprayWallBoardFromLink(queryClient, WALL_UUID, WALL_SLUG)).resolves.toEqual(wall.board);
    expect(queryClient.getQueryData(sprayWallByLayoutQueryKey(4242))).toEqual({ sprayWallByLayout: wall });
    expect(queryClient.getQueryCache().findAll({ queryKey: ['boardBySlug'] })).toHaveLength(0);
    expect(request).toHaveBeenCalledWith(GET_SPRAY_WALL_FOR_LINK, { uuid: WALL_UUID });
  });

  it('forces registration after authorization when a render lookup failed earlier', async () => {
    request.mockResolvedValue({ sprayWall: wall });
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);
    unregisterSprayWall(4242);
    expect(getSprayWallLoadState(4242)).toBe('unavailable');
    await fetchSprayWallBoardFromLink(makeQueryClient(), WALL_UUID, WALL_SLUG);
    expect(loader).toHaveBeenCalledWith(4242, { force: true });
  });

  it.each(['private', 'hidden', 'deleted'])('rejects a server-denied %s wall without writes', async () => {
    request.mockResolvedValue({ sprayWall: null });
    const queryClient = makeQueryClient();
    await expect(fetchSprayWallBoardFromLink(queryClient, WALL_UUID, WALL_SLUG)).resolves.toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it.each([
    { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { slug: 'another-wall' },
    { boardType: 'kilter' },
    { layoutId: 99 },
  ])('does not hydrate art for a mismatched board: %j', async (mismatch) => {
    request.mockResolvedValue({ sprayWall: { ...wall, board: { ...wall.board, ...mismatch } } });
    const queryClient = makeQueryClient();
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);
    await expect(fetchSprayWallBoardFromLink(queryClient, WALL_UUID, WALL_SLUG)).resolves.toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(loader).not.toHaveBeenCalled();
  });

  it('rejects a response naming a different capability UUID', async () => {
    request.mockResolvedValue({ sprayWall: { ...wall, uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } });
    const queryClient = makeQueryClient();
    await expect(fetchSprayWallBoardFromLink(queryClient, WALL_UUID, WALL_SLUG)).resolves.toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('rechecks access despite a cached wall that has become private or hidden', async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(['sprayWall', WALL_UUID], { sprayWall: wall });
    request.mockResolvedValue({ sprayWall: null });
    await expect(fetchSprayWallBoardFromLink(queryClient, WALL_UUID, WALL_SLUG)).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(sprayWallByLayoutQueryKey(4242))).toBeUndefined();
  });

  it('discards a response that completes after credentials changed', async () => {
    request.mockImplementation(async () => {
      credentials.generation += 1;
      return { sprayWall: wall };
    });
    const queryClient = makeQueryClient();
    await expect(fetchSprayWallBoardFromLink(queryClient, WALL_UUID, WALL_SLUG)).resolves.toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('propagates a network rejection without seeding cache or registering art', async () => {
    request.mockRejectedValue(new TypeError('Network request failed'));
    const queryClient = makeQueryClient();
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);
    await expect(fetchSprayWallBoardFromLink(queryClient, WALL_UUID, WALL_SLUG)).rejects.toThrow(
      'Network request failed',
    );
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(loader).not.toHaveBeenCalled();
  });

  it('selects a complete board with an operation accepted by the server schema', () => {
    expect(validate(buildSchema(typeDefs.join('\n')), parse(GET_SPRAY_WALL_FOR_LINK))).toEqual([]);
  });
});

describe('isWallUuidParam', () => {
  it('accepts a uuid and rejects everything else', () => {
    expect(isWallUuidParam(WALL_UUID)).toBe(true);
    expect(isWallUuidParam(WALL_UUID.toUpperCase())).toBe(true);
    expect(isWallUuidParam('4242')).toBe(false);
    expect(isWallUuidParam('')).toBe(false);
    expect(isWallUuidParam(undefined)).toBe(false);
  });
});
