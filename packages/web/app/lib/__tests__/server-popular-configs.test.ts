import { describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: never[]) => unknown) => fn,
}));

const backend = vi.hoisted(() => ({ hasMore: false, totalCount: 51 }));

const CONFIG: PopularBoardConfig = {
  boardType: 'kilter',
  layoutId: 1,
  layoutName: 'Kilter Board Original',
  sizeId: 10,
  sizeName: '12 x 12 with kickboard',
  sizeDescription: '12 x 12 Square',
  setIds: [1, 20],
  setNames: ['Bolt Ons', 'Screw Ons'],
  climbCount: 4200,
  totalAscents: 99,
  boardCount: 12,
  displayName: 'Kilter Original 12x12',
};

const requestedInputs: unknown[] = [];

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  executeGraphQLInternal: async (_document: unknown, variables: { input: unknown }) => {
    requestedInputs.push(variables.input);
    return {
      popularBoardConfigs: {
        configs: [CONFIG],
        hasMore: backend.hasMore,
        totalCount: backend.totalCount,
      },
    };
  },
}));

const { getAllBoardConfigsOrThrow } = await import('../server-popular-configs');

describe('getAllBoardConfigsOrThrow', () => {
  it('asks for the API cap in one page', () => {
    requestedInputs.length = 0;
    return getAllBoardConfigsOrThrow().then((configs) => {
      expect(configs).toEqual([CONFIG]);
      expect(requestedInputs[0]).toEqual({ limit: 100, offset: 0 });
    });
  });

  it('throws rather than quietly dropping the tail when the API says there is more', async () => {
    // `limit: 100` is the schema's hard max, so a catalogue that outgrows it can
    // only be reached by paging. Returning the first 100 with a 200 tells Google
    // the rest of the board pages were deleted — the exact failure the shard's
    // 503 doctrine exists to prevent, so this must surface as a throw.
    backend.hasMore = true;
    backend.totalCount = 137;
    try {
      await expect(getAllBoardConfigsOrThrow()).rejects.toThrow(/truncated/);
      await expect(getAllBoardConfigsOrThrow()).rejects.toThrow(/137/);
    } finally {
      backend.hasMore = false;
      backend.totalCount = 51;
    }
  });
});
