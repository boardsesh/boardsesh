import { cache } from 'react';
import { FRONT_DOOR_READ_DEADLINE_MS } from '@/app/lib/db/read-deadline';

/**
 * A read that gets less than this is not worth issuing, and a floor keeps an
 * exhausted budget from turning into a 0 ms deadline that can beat an already
 * resolved promise on a busy event loop.
 *
 * The cost of the floor, stated plainly: a request whose budget is already spent
 * can still overrun it by up to this much per remaining read, so the climb
 * page's worst case is ~6 s + 2 × 500 ms rather than exactly 6 s.
 */
export const MIN_REMAINING_READ_BUDGET_MS = 500;

export type ReadBudget = { deadlineAt: number };

/**
 * One deadline per server request, not per statement.
 *
 * The climb front door issues three reads in sequence — alias, climb select,
 * then the angle table — so a per-statement ceiling of 6 s is really a ~18 s
 * request. Every one of those seconds is spent holding a pool slot on a
 * database that is by construction already saturated, which is the opposite of
 * shedding load. React's `cache` scopes this object to the render, so the three
 * reads share one budget and the request as a whole is bounded.
 *
 * Outside a render scope — scripts, unit tests — React's `cache` is a
 * passthrough, so each call starts a fresh budget and the behaviour degrades to
 * the per-statement deadline. That is the pre-existing behaviour, not a
 * regression, and no server request goes down that path.
 */
export const currentReadBudget = cache((): ReadBudget => ({
  deadlineAt: Date.now() + FRONT_DOOR_READ_DEADLINE_MS,
}));

/** How much of the request's budget is left, floored. Pure, so it is testable. */
export function remainingBudgetMs(budget: ReadBudget, now: number = Date.now()): number {
  return Math.max(MIN_REMAINING_READ_BUDGET_MS, budget.deadlineAt - now);
}

/** The remaining budget for the current request. */
export function remainingReadBudgetMs(): number {
  return remainingBudgetMs(currentReadBudget());
}
