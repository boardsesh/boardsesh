import { describe, expect, it } from 'vite-plus/test';
import { MAX_SEARCH_PAGE } from '@boardsesh/db/queries';
import { ClimbSearchInputSchema } from '../validation/schemas';

const base = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 7,
  setIds: '1',
  angle: 40,
};

describe('ClimbSearchInputSchema page bound', () => {
  it('accepts pages up to MAX_SEARCH_PAGE', () => {
    expect(ClimbSearchInputSchema.safeParse({ ...base, page: 0 }).success).toBe(true);
    expect(ClimbSearchInputSchema.safeParse({ ...base, page: MAX_SEARCH_PAGE }).success).toBe(true);
  });

  it('rejects pages past MAX_SEARCH_PAGE to block deep-OFFSET abuse', () => {
    const result = ClimbSearchInputSchema.safeParse({ ...base, page: MAX_SEARCH_PAGE + 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === 'Page number too large')).toBe(true);
    }
  });
});

describe('ClimbSearchInputSchema holdsFilter cap', () => {
  it('accepts a realistic number of hold filters', () => {
    const holdsFilter: Record<string, { ANY: 'include' }> = {};
    for (let holdId = 1; holdId <= 50; holdId++) holdsFilter[`hold_${holdId}`] = { ANY: 'include' };
    expect(ClimbSearchInputSchema.safeParse({ ...base, holdsFilter }).success).toBe(true);
  });

  it('rejects an oversized holdsFilter record', () => {
    const holdsFilter: Record<string, { ANY: 'include' }> = {};
    for (let holdId = 1; holdId <= 400; holdId++) holdsFilter[`hold_${holdId}`] = { ANY: 'include' };
    const result = ClimbSearchInputSchema.safeParse({ ...base, holdsFilter });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === 'Too many hold filters')).toBe(true);
    }
  });
});
