// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';

import { MIN_REMAINING_READ_BUDGET_MS, remainingBudgetMs } from '../request-read-budget';

describe('remainingBudgetMs', () => {
  it('hands back what is left of the request budget', () => {
    expect(remainingBudgetMs({ deadlineAt: 10_000 }, 4_000)).toBe(6_000);
    expect(remainingBudgetMs({ deadlineAt: 10_000 }, 8_000)).toBe(2_000);
  });

  it('floors an exhausted budget rather than issuing a 0 ms deadline', () => {
    // A 0 ms deadline can beat an already-resolved promise on a busy event loop,
    // turning a cache hit into a spurious timeout.
    expect(remainingBudgetMs({ deadlineAt: 10_000 }, 10_000)).toBe(MIN_REMAINING_READ_BUDGET_MS);
    expect(remainingBudgetMs({ deadlineAt: 10_000 }, 25_000)).toBe(MIN_REMAINING_READ_BUDGET_MS);
  });
});
