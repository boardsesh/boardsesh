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
  queryImpl: { current: async (_tag: string, _variables: unknown): Promise<unknown> => ({}) },
  captureMessageMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  createCachedGraphQLQuery: (_document: unknown, tag: string) => (variables: unknown) =>
    queryImpl.current(tag, variables),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: captureMessageMock,
  withScope: (callback: (scope: { setFingerprint: () => void; setTag: () => void; setExtra: () => void }) => void) =>
    callback({ setFingerprint: () => {}, setTag: () => {}, setExtra: () => {} }),
}));

import {
  __resetFrontDoorReportingForTests,
  getFrontDoorBetaLinks,
  getFrontDoorSimilarClimbs,
} from '../front-door-data.server';

/** What `AbortController.abort()` produces once graphql-request rethrows it. */
function abortError(): Error {
  return Object.assign(new Error('AbortError: This operation was aborted'), { name: 'AbortError' });
}

const nearbyParams = {
  boardType: 'kilter',
  layoutId: 8,
  climbUuid: 'current-climb',
  angle: 40,
  fallback: { sizeId: 23, setIds: [27, 26], difficulty: '7a+/V7' },
} as const;

describe('front-door reads distinguish "timed out" from "empty"', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Reset the report-interval latch so it cannot carry state in from
    // another test file in this worker.
    __resetFrontDoorReportingForTests();
    queryImpl.current = async () => ({ similarClimbs: [], betaLinks: [] });
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

    await getFrontDoorSimilarClimbs(nearbyParams);

    // A second attempt would spend another 3 s of the reader's page load on
    // the same pool that just failed to answer in three. The retry belongs in
    // the browser, not here.
    expect(attempts).toBe(1);
  });

  it('queries the requested wall and nearby grade band after an empty similarity read', async () => {
    const searchRow = {
      name: 'Another climb',
      setter_username: 'setter',
      frames: 'p1r12',
      difficulty: '7a/V6',
      compatibleSizeIds: [23],
      ascensionist_count: 20,
      quality_average: '4.1',
    };
    const candidates = Array.from({ length: 6 }, (_, index) => ({ ...searchRow, uuid: `eligible-${index}` }));
    const query = vi.fn(async (tag: string) =>
      tag === 'similar-climbs'
        ? { similarClimbs: [] }
        : {
            searchClimbs: {
              climbs: [{ ...searchRow, uuid: nearbyParams.climbUuid }, ...candidates],
            },
          },
    );
    queryImpl.current = query;

    const section = await getFrontDoorSimilarClimbs(nearbyParams);

    expect(query).toHaveBeenNthCalledWith(2, 'nearby-climbs', {
      input: {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 23,
        setIds: '26,27',
        angle: 40,
        minGrade: 22,
        maxGrade: 25,
        minAscents: 1,
        sortBy: 'ascents',
        sortOrder: 'desc',
        page: 0,
        pageSize: 7,
      },
    });
    expect(section).toMatchObject({
      status: 'loaded',
      items: [],
      nearby: {
        status: 'loaded',
        grade: '7a+/V7',
        items: candidates.map(({ uuid }) => ({ uuid, angle: 40, layoutId: 8, difficultyName: '7a/V6' })),
      },
    });
  });

  it.each([
    ['checks one more page if the first seven MoonBoard climbs need uninstalled sets', false],
    ['keeps a compatible MoonBoard result from the first page without another read', true],
  ] as const)('%s', async (_description, firstPageHasMatch) => {
    // On the 2024 layout cell 1 uses Hold Set D (5) and cell 2 needs Wooden Holds (8).
    const candidate = {
      uuid: 'fits-hold-set',
      name: 'Hold Set D climb',
      setter_username: 'setter',
      frames: 'p1r42',
      difficulty: '7a/V6',
      compatibleSizeIds: [1],
      ascensionist_count: 20,
      quality_average: '4.1',
    };
    const firstPage = Array.from({ length: 7 }, (_, index) => ({
      ...candidate,
      uuid: `wrong-hold-set-${index}`,
      frames: 'p2r42',
    }));
    if (firstPageHasMatch) firstPage[6] = candidate;

    const query = vi
      .fn()
      .mockResolvedValueOnce({ similarClimbs: [] })
      .mockResolvedValueOnce({ searchClimbs: { climbs: firstPage } })
      .mockResolvedValueOnce({ searchClimbs: { climbs: [candidate] } });
    queryImpl.current = query;

    const section = await getFrontDoorSimilarClimbs({
      ...nearbyParams,
      boardType: 'moonboard',
      layoutId: 3,
      fallback: { sizeId: 1, setIds: [5], difficulty: '7a/V6' },
    });

    expect(section).toMatchObject({ nearby: { status: 'loaded', items: [{ uuid: 'fits-hold-set' }] } });
    expect(query).toHaveBeenCalledTimes(firstPageHasMatch ? 2 : 3);
    if (!firstPageHasMatch) {
      expect(query).toHaveBeenLastCalledWith('nearby-climbs', { input: expect.objectContaining({ page: 1 }) });
    }
  });

  it('keeps shared-hold matches without asking for nearby grades', async () => {
    const items = [{ uuid: 'shared-hold-match' }];
    const query = vi.fn(async () => ({ similarClimbs: items }));
    queryImpl.current = query;

    expect(await getFrontDoorSimilarClimbs(nearbyParams)).toEqual({ status: 'loaded', items });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps the nearby fallback disabled for an ungraded climb', async () => {
    const query = vi.fn(async () => ({ similarClimbs: [] }));
    queryImpl.current = query;

    expect(
      await getFrontDoorSimilarClimbs({ ...nearbyParams, fallback: { ...nearbyParams.fallback, difficulty: '' } }),
    ).toEqual({ status: 'loaded', items: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an unavailable fallback from an empty similar-climbs answer', async () => {
    queryImpl.current = async (tag) => {
      if (tag === 'similar-climbs') return { similarClimbs: [] };
      throw abortError();
    };

    expect(await getFrontDoorSimilarClimbs(nearbyParams)).toEqual({
      status: 'loaded',
      items: [],
      nearby: { status: 'unavailable', grade: '7a+/V7' },
    });
  });
});
