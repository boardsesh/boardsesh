import { describe, expect, it, vi, beforeEach } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import type { Climb, ClimbSearchInput, UserBoard } from '@boardsesh/shared-schema';
import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  generateStagedPlan,
  planFromBlocks,
  type GeneratorGradeScale,
} from '@boardsesh/playlist-generator';
import { SEARCH_CLIMBS } from '../../../../lib/graphql/operations';
import { buildPools, selectItemsFromPools, type PreviewFetchContext } from '../workout-preview-pool';

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
import { MAX_SEARCH_PAGE_SIZE, buildClimbSearchInput, fetchGradePool } from '../select-climbs-for-plan';

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
    expect(pool).toEqual({ climbs, topUpTiers: new Map(), exhausted: true });
  });

  it('returns the empty pool from the offline fallback, never as all the grade has', async () => {
    onlineManager.setOnline(false);
    offlineAwareRequestMock.mockResolvedValue({ searchClimbs: { climbs: [], hasMore: false } });

    try {
      await expect(fetchGradePool(15, ctx)).resolves.toEqual({ climbs: [], topUpTiers: new Map(), exhausted: false });
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('reads past the 100-climb page cap when the demand needs it', async () => {
    serveCatalogue(300);

    const { climbs } = await fetchGradePool(15, ctx, 150);

    // 150 slots + 10 spare = 160 wanted, in pages of 100.
    expect(climbs).toHaveLength(200);
    expect(new Set(climbs.map((climb) => climb.uuid)).size).toBe(200);
    expect(requestedPages()).toEqual([
      { page: 0, pageSize: MAX_SEARCH_PAGE_SIZE },
      { page: 1, pageSize: MAX_SEARCH_PAGE_SIZE },
    ]);
  });

  it('stops when the grade runs out', async () => {
    serveCatalogue(120);

    const { climbs, exhausted } = await fetchGradePool(15, ctx, 400);

    expect(climbs).toHaveLength(120);
    expect(exhausted).toBe(true);
    expect(requestedPages().map(({ page }) => page)).toEqual([0, 1]);
  });

  it('stops paging when the backend repeats a page and still says hasMore', async () => {
    const repeatedPage = Array.from({ length: MAX_SEARCH_PAGE_SIZE }, (_, index) => ({ uuid: `climb-${index}` }));
    offlineAwareRequestMock.mockResolvedValue({ searchClimbs: { climbs: repeatedPage, hasMore: true } });

    const { climbs, exhausted } = await fetchGradePool(15, ctx, 150);

    // 160 wanted fits in 2 pages of 100; 2 more are allowed before giving up.
    expect(climbs).toHaveLength(MAX_SEARCH_PAGE_SIZE);
    expect(exhausted).toBe(false);
    expect(offlineAwareRequestMock).toHaveBeenCalledTimes(4);
  });

  it('keeps the 50-climb pool for a demand that fits in it', async () => {
    serveCatalogue(300);

    await fetchGradePool(15, ctx, 20);

    expect(requestedPages()).toEqual([{ page: 0, pageSize: 50 }]);
  });

  it('fills two blocks at one grade when together they need more than 50 climbs', async () => {
    serveCatalogue(200);
    const grades: GeneratorGradeScale = Array.from({ length: 20 }, (_, index) => ({ difficulty_id: index + 10 }));
    const plan = planFromBlocks(
      [
        { kind: 'workout', options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 15, numberOfClimbs: 40 } },
        { kind: 'workout', options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 15, numberOfClimbs: 30 } },
      ],
      (stagePosition) => `stage-${stagePosition}`,
    );
    const slots = generateStagedPlan(plan, grades);

    const pools = await buildPools(slots, ctx, fetchGradePool);
    const { items } = selectItemsFromPools(slots, pools);

    expect(slots).toHaveLength(70);
    expect(items).toHaveLength(70);
    expect(items.filter((preview) => preview.slot.stageId === 'stage-1')).toHaveLength(30);
  });
});

// A grade with `size` climbs, served one page at a time like SEARCH_CLIMBS.
function serveCatalogue(size: number) {
  const catalogue = Array.from({ length: size }, (_, index) => ({ uuid: `climb-${index}` }) as Climb);
  offlineAwareRequestMock.mockImplementation(async (_query, variables) => {
    const { input } = variables as { input: ClimbSearchInput };
    const page = input.page ?? 0;
    const pageSize = input.pageSize ?? 20;
    const climbs = catalogue.slice(page * pageSize, (page + 1) * pageSize);
    return { searchClimbs: { climbs, hasMore: (page + 1) * pageSize < catalogue.length } };
  });
}

function requestedPages() {
  return offlineAwareRequestMock.mock.calls.map(([, variables]) => {
    const { input } = variables as { input: ClimbSearchInput };
    return { page: input.page, pageSize: input.pageSize };
  });
}

describe('buildClimbSearchInput grade source', () => {
  it('leaves the request untouched with the preference off', () => {
    const off = buildClimbSearchInput(15, ctx);
    expect(off).not.toHaveProperty('gradeSource');
    expect(buildClimbSearchInput(15, { ...ctx, boardseshGrades: false })).toEqual(off);
  });

  it('searches on the Boardsesh grade with the preference on', () => {
    expect(buildClimbSearchInput(15, { ...ctx, boardseshGrades: true })).toMatchObject({
      minGrade: 15,
      maxGrade: 15,
      gradeSource: 'BOARDSESH',
    });
  });
});
