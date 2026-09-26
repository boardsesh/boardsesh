import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/error-reporting', () => ({ addErrorBreadcrumb: vi.fn() }));

import { addErrorBreadcrumb } from '../../lib/error-reporting';
import { holdIndexSyncOptions, parseHoldRows } from '../hold-index-parser';

describe('hold index parser binding', () => {
  it('parses a known board with the board-constants role table', () => {
    expect(parseHoldRows('kilter', 'p1r12p2r13')).toEqual([
      { holdId: 1, holdState: 'STARTING' },
      { holdId: 2, holdState: 'HAND' },
    ]);
  });

  it('yields no rows for a board type with no role table', () => {
    expect(parseHoldRows('not-a-board', 'p1r12')).toEqual([]);
  });

  it('turns a failed build into a breadcrumb, not an error report', () => {
    holdIndexSyncOptions.onError?.(new Error('database is locked'), 'kilter:1:10');
    expect(addErrorBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'offline-sync',
        level: 'warning',
        data: { scopeKey: 'kilter:1:10', error: 'database is locked' },
      }),
    );
  });
});
