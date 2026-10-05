import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import { SEARCH_CLIMBS } from '@boardsesh/graphql/operations';
import type { PreviewFetchContext } from '../workout-preview-pool';

// Keep expo-crypto (pulled in via workout-preview-pool → climb-to-queue-item)
// out of the node test environment — it drags in raw react-native source.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'qi-0' }));

// fetchGradePool must go through the offline interceptor (issue #3472) so
// "plan my session" works offline on a downloaded board — not getHttpClient()
// directly, which bypasses local SQLite.
vi.mock('../../../../lib/graphql/offline-request', () => ({
  offlineAwareRequest: vi.fn(),
}));

import { offlineAwareRequest } from '../../../../lib/graphql/offline-request';
import { buildClimbSearchInput, fetchGradePool } from '../select-climbs-for-plan';

const offlineAwareRequestMock = vi.mocked(offlineAwareRequest);

const ctx: PreviewFetchContext = {
  board: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard,
  isAuthenticated: false,
};

describe('fetchGradePool', () => {
  beforeEach(() => {
    offlineAwareRequestMock.mockReset();
  });

  it('routes SEARCH_CLIMBS through the offline interceptor with the built input', async () => {
    const climbs = [{ uuid: 'climb-1' } as Climb];
    offlineAwareRequestMock.mockResolvedValue({ searchClimbs: { climbs, hasMore: false } });

    const pool = await fetchGradePool(15, ctx);

    expect(offlineAwareRequestMock).toHaveBeenCalledExactlyOnceWith(SEARCH_CLIMBS, {
      input: buildClimbSearchInput(15, ctx),
    });
    expect(pool).toEqual(climbs);
  });

  it('returns the empty pool from the offline fallback', async () => {
    offlineAwareRequestMock.mockResolvedValue({ searchClimbs: { climbs: [], hasMore: false } });

    await expect(fetchGradePool(15, ctx)).resolves.toEqual([]);
  });
});
