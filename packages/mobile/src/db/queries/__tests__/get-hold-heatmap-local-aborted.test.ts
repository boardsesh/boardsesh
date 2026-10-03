import { describe, expect, it, vi } from 'vitest';
import type { OfflineDatabase } from '@boardsesh/offline-sync';

// An interrupted holds-index build must not produce a heatmap: the index is
// partial, so every count would be low. Kept apart from the SQLite suite because
// it replaces the builder.
const { ensureHoldIndex } = vi.hoisted(() => ({ ensureHoldIndex: vi.fn() }));
vi.mock('@boardsesh/offline-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/offline-sync')>()),
  ensureHoldIndex,
}));
vi.mock('../../../lib/error-reporting', () => ({ addErrorBreadcrumb: vi.fn() }));

import { getHoldHeatmapLocal } from '../get-hold-heatmap-local';

describe('getHoldHeatmapLocal — interrupted index build', () => {
  it.each(['aborted', 'not-downloaded'])('rejects an index that is %s', async (status) => {
    ensureHoldIndex.mockResolvedValue({ status });
    const getAllAsync = vi.fn().mockResolvedValue([]);
    const db = { getAllAsync, getFirstAsync: vi.fn().mockResolvedValue(null) } as unknown as OfflineDatabase;

    await expect(
      getHoldHeatmapLocal(db, { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '', angle: 40 }),
    ).rejects.toThrow(/interrupted|no longer downloaded/);
    expect(getAllAsync.mock.calls.every(([sql]) => !sql.includes('board_climb_hold_sets'))).toBe(true);
  });
});
