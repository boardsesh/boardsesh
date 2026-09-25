// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * #4968, at the read layer: a backend that did not answer must not be reported
 * as a backend that answered with nothing.
 *
 * The distinction is invisible in a test that only counts array length, which
 * is how this shipped: both helpers used to `return []` on any rejection, so an
 * AbortError from the 3 s deadline and a genuinely unfilmed climb produced the
 * identical value and the page rendered its "nothing here yet" copy for both.
 */
const { queryImpl, captureMessageMock } = vi.hoisted(() => ({
  queryImpl: { current: async () => ({ similarClimbs: [], betaLinks: [] }) as unknown },
  captureMessageMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  createCachedGraphQLQuery: () => async () => queryImpl.current(),
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: captureMessageMock }));

import { getFrontDoorBetaLinks, getFrontDoorSimilarClimbs } from '../front-door-data.server';

/** What `AbortController.abort()` produces once graphql-request rethrows it. */
function abortError(): Error {
  return Object.assign(new Error('AbortError: This operation was aborted'), { name: 'AbortError' });
}

describe('front-door reads distinguish "timed out" from "empty"', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Drive both sections back to "recovered" so the module's once-per-outage
    // dedupe Set cannot carry state in from another test file in this worker.
    queryImpl.current = async () => ({ similarClimbs: [], betaLinks: [] });
    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'warmup', angle: 40 });
    await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'warmup' });
  });

  it('reports similar climbs as unavailable when the deadline fires', async () => {
    queryImpl.current = async () => {
      throw abortError();
    };

    const section = await getFrontDoorSimilarClimbs({
      boardType: 'kilter',
      layoutId: 8,
      climbUuid: 'climb-1',
      angle: 40,
    });

    expect(section).toEqual({ status: 'unavailable' });
  });

  it('reports beta links as unavailable when the deadline fires', async () => {
    queryImpl.current = async () => {
      throw abortError();
    };

    const section = await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' });

    expect(section).toEqual({ status: 'unavailable' });
  });

  it('reports a genuinely empty answer as loaded, so the page can say so', async () => {
    queryImpl.current = async () => ({ similarClimbs: [], betaLinks: [] });

    expect(
      await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-1', angle: 40 }),
    ).toEqual({ status: 'loaded', items: [] });
    expect(await getFrontDoorBetaLinks({ boardType: 'kilter', climbUuid: 'climb-1' })).toEqual({
      status: 'loaded',
      items: [],
    });
  });

  it('degrades on the first failure rather than retrying into a wedged backend', async () => {
    let attempts = 0;
    queryImpl.current = async () => {
      attempts += 1;
      throw abortError();
    };

    await getFrontDoorSimilarClimbs({ boardType: 'kilter', layoutId: 8, climbUuid: 'climb-1', angle: 40 });

    // A second attempt would spend another 3 s of the reader's page load on
    // the same pool that just failed to answer in three. The retry belongs in
    // the browser, not here.
    expect(attempts).toBe(1);
  });
});
