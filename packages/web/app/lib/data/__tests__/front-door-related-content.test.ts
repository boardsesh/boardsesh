// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PublicClimbRelatedContentQueryResponse } from '@boardsesh/graphql/operations/public-climb-related-content';

const { execute, captureMessage, scope } = vi.hoisted(() => ({
  execute: vi.fn(),
  captureMessage: vi.fn(),
  scope: { setFingerprint: vi.fn(), setTag: vi.fn(), setExtra: vi.fn() },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/server-cached-client', () => ({ executeGraphQLInternal: execute }));
vi.mock('@sentry/nextjs', () => ({
  captureMessage,
  withScope: (callback: (current: typeof scope) => void) => callback(scope),
}));

import { __resetFrontDoorReportingForTests, getFrontDoorRelatedContent } from '../front-door-data.server';

const input = {
  boardType: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: [1, 20],
  angle: 40,
  climbUuid: 'canonical-climb',
  includeNearby: true,
};
const empty: PublicClimbRelatedContentQueryResponse = {
  publicClimbRelatedContent: {
    similarStatus: 'loaded',
    similarClimbs: [],
    nearbyStatus: null,
    nearbyGrade: null,
    nearbyClimbs: [],
    betaStatus: 'loaded',
    betaLinks: [],
    betaHasMore: false,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetFrontDoorReportingForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  execute.mockResolvedValue(empty);
});
afterEach(() => vi.restoreAllMocks());

describe('public climb supplementary content', () => {
  it('uses one backend request without a web-local visibility cache', async () => {
    expect(await getFrontDoorRelatedContent(input)).toEqual({
      similarClimbs: { status: 'loaded', items: [] },
      betaLinks: { status: 'loaded', items: [], hasMore: false },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('PublicClimbRelatedContent'), { input });
  });

  it('preserves nearby suggestions and their grade separately from similarity', async () => {
    execute.mockResolvedValue({
      publicClimbRelatedContent: {
        ...empty.publicClimbRelatedContent,
        nearbyStatus: 'loaded',
        nearbyGrade: '7a/V6',
        nearbyClimbs: [{ uuid: 'nearby' }],
      },
    });
    expect((await getFrontDoorRelatedContent(input)).similarClimbs).toEqual({
      status: 'loaded',
      items: [],
      nearby: { status: 'loaded', items: [{ uuid: 'nearby' }], grade: '7a/V6' },
    });
  });

  it('preserves independent unavailable sections rather than publishing empty claims', async () => {
    execute.mockResolvedValue({
      publicClimbRelatedContent: {
        ...empty.publicClimbRelatedContent,
        nearbyStatus: 'unavailable',
        nearbyGrade: '7a/V6',
        betaStatus: 'unavailable',
      },
    });
    const content = await getFrontDoorRelatedContent(input);
    expect(content.betaLinks).toEqual({ status: 'unavailable' });
    expect(content.similarClimbs).toMatchObject({ nearby: { status: 'unavailable', grade: '7a/V6' } });
  });

  it('degrades both sections on a bounded backend timeout', async () => {
    execute.mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    expect(await getFrontDoorRelatedContent(input)).toEqual({
      similarClimbs: { status: 'unavailable' },
      betaLinks: { status: 'unavailable' },
    });
    expect(scope.setFingerprint).toHaveBeenCalledWith(['front-door-unavailable', 'similar-climbs', 'timeout']);
  });

  it('bounds outage reports across many unique climb URLs and recovery flaps', async () => {
    execute.mockRejectedValue(new Error('Backend down'));
    for (let index = 0; index < 40; index++)
      await getFrontDoorRelatedContent({ ...input, climbUuid: `climb-${index}` });
    expect(captureMessage).toHaveBeenCalledTimes(2);
    execute.mockResolvedValueOnce(empty);
    await getFrontDoorRelatedContent(input);
    execute.mockRejectedValue(new Error('Backend down again'));
    await getFrontDoorRelatedContent(input);
    expect(captureMessage).toHaveBeenCalledTimes(2);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 60_000);
    await getFrontDoorRelatedContent(input);
    expect(captureMessage).toHaveBeenCalledTimes(4);
  });
});
