// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The caller-side half of the backend deadline. The unit test on
 * `createCachedGraphQLQuery` stays green if either call site drops its fourth
 * argument, which is the inert-guard shape this campaign keeps hitting.
 */
const { createCachedGraphQLQueryMock, factoryCalls } = vi.hoisted(() => {
  const factoryCalls: unknown[][] = [];
  return {
    factoryCalls,
    createCachedGraphQLQueryMock: vi.fn((...args: unknown[]) => {
      factoryCalls.push(args);
      return async () => ({ similarClimbs: [], betaLinks: [] });
    }),
  };
});

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  createCachedGraphQLQuery: createCachedGraphQLQueryMock,
}));

import { getFrontDoorBetaLinks, getFrontDoorSimilarClimbs } from '../front-door-data.server';

/** Shorter than the 6 s DB deadline: these sections are supplementary. */
const EXPECTED_BACKEND_TIMEOUT_MS = 3000;

describe('front-door backend calls carry a deadline', () => {
  beforeEach(() => {
    factoryCalls.length = 0;
    createCachedGraphQLQueryMock.mockClear();
  });

  it('bounds the similar-climbs read', async () => {
    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-1', angle: 40 });

    expect(factoryCalls[0]?.[3]).toBe(EXPECTED_BACKEND_TIMEOUT_MS);
  });

  it('bounds the beta-links read', async () => {
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });

    expect(factoryCalls[0]?.[3]).toBe(EXPECTED_BACKEND_TIMEOUT_MS);
  });
});
