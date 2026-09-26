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
  it('throws instead of aggregating a partial index', async () => {
    ensureHoldIndex.mockResolvedValue({ status: 'aborted' });
    const getAllAsync = vi.fn();
    const db = { getAllAsync, getFirstAsync: vi.fn() } as unknown as OfflineDatabase;

    await expect(
      getHoldHeatmapLocal(db, { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '', angle: 40 }),
    ).rejects.toThrow(/interrupted/);
    expect(getAllAsync).not.toHaveBeenCalled();
  });
});
