import { AURORA_USER_SYNC_BOARDS } from './aurora-user-sync';

/**
 * The lease and retry budget of the two hourly board-wide families, and the
 * deadline derived from them. In one module so both families take their
 * options from here and the deadline can count both without an import cycle.
 */

/** One `aurora-shared-sync` attempt's lease, its retries and the wait before one. */
export const AURORA_SHARED_SYNC_BUDGET = { expireInSeconds: 3600, retryLimit: 1, retryDelay: 300 } as const;

/** The same for `kilter-catalog-sync`, queued at :23 behind the :07 fan-out. */
export const KILTER_CATALOG_SYNC_BUDGET = { expireInSeconds: 3600, retryLimit: 1, retryDelay: 300 } as const;

/** Room for the routine cycles that share the one-at-a-time worker with the fan-out. */
const FAN_OUT_SLACK_SECONDS = 3600;

/** The longest one run can hold the worker: its lease, its retries and the waits between. */
function worstCaseSeconds(budget: { expireInSeconds: number; retryLimit: number; retryDelay: number }): number {
  return budget.expireInSeconds * (1 + budget.retryLimit) + budget.retryDelay * budget.retryLimit;
}

/**
 * The absolute deadline of everything that waits behind the hourly fan-out
 * (`aurora-shared-sync`, `kilter-catalog-sync`, `provider-routine-cycle`). The
 * routine worker runs one job at a time, so the last run can wait behind every
 * board's shared sync (every board in AURORA_BOARDS except Kilter) and the
 * Kilter catalog, each using its lease and its retries:
 *
 *   boards x worst(shared) + worst(catalog) + slack
 *
 * Derived from the budgets above, so a longer lease or another retry moves it.
 */
export const BOARD_WIDE_FAN_OUT_DEADLINE_SECONDS =
  AURORA_USER_SYNC_BOARDS.length * worstCaseSeconds(AURORA_SHARED_SYNC_BUDGET) +
  worstCaseSeconds(KILTER_CATALOG_SYNC_BUDGET) +
  FAN_OUT_SLACK_SECONDS;
