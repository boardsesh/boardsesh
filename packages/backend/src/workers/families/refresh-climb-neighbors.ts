import { z } from 'zod';
import {
  CLIMB_NEIGHBOR_BOARDS,
  ClimbNeighborsInterruptedError,
  isGapRefillDay,
  orderBoardsByClimbCount,
  runRefreshClimbNeighbors,
} from '@boardsesh/db/jobs';
import { fencedTransact, jobLogger } from './batch-job';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';

const payload = z
  .object({
    board: z.enum(CLIMB_NEIGHBOR_BOARDS),
    full: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    /** Unset: the Sunday (UTC) run scans for lists that lost a row, as the workflow does. */
    refillGaps: z.boolean().optional(),
  })
  .strict();

export type RefreshClimbNeighborsPayload = z.infer<typeof payload>;

/**
 * Nightly similar-climbs index for one board (`@boardsesh/db/jobs`,
 * docs/similar-climbs.md). The schedule fans out one job per board, cheapest
 * first, and the batch worker runs them one at a time. Each chunk of up to
 * 1,000 lists commits in its own fenced batch; the watermark moves in the last
 * one. A run stopped by its signal (shutdown, lease, lost attempt) fails
 * `INTERRUPTED` and retries, and the retry resumes from what was recorded.
 */
export const refreshClimbNeighborsFamily: BackgroundJobFamilyModule<RefreshClimbNeighborsPayload> = {
  name: 'refresh-climb-neighbors',
  roles: ['batch'],
  options: {
    // Full builds on GitHub Actions (Sep 2026): Kilter about 10 minutes,
    // MoonBoard about 13; a normal night is seconds per board. The workflow
    // gives each board 350 minutes, so the lease matches that order.
    expireInSeconds: 21_600,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 900,
    deadlineSeconds: 79_200,
    // The longest fenced batch is one chunk of 1,000 lists: about 4 s on a
    // MoonBoard layout-2 chunk (12 rows per list), compute included, and the
    // closing sweep + watermark took 0.6 s. The safe bound is the window minus
    // 10 s; 60 s leaves 50 s, room for the homelab VM's slower round trips to
    // the Railway primary, which have not been measured yet.
    heartbeatSeconds: 60,
  },
  payload,
  singletonKey: ({ board }) => board,
  schedules: [
    {
      key: 'nightly',
      cron: '45 6 * * *',
      // One job per board, cheapest first: the stately queue hands them to the
      // batch worker in enqueue order, so the small catalogues finish before Kilter.
      fanOut: async (database) =>
        (await orderBoardsByClimbCount(database, CLIMB_NEIGHBOR_BOARDS)).map((board) => ({ payload: { board } })),
    },
  ],
  async execute(context, { board, full, dryRun, refillGaps }) {
    try {
      await runRefreshClimbNeighbors({
        db: context.database,
        signal: context.signal,
        transact: fencedTransact(context),
        log: jobLogger(context),
        boards: [board],
        full: full ?? false,
        dryRun: dryRun ?? false,
        refillGaps: refillGaps ?? isGapRefillDay(new Date()),
      });
    } catch (error) {
      if (error instanceof ClimbNeighborsInterruptedError) throw new BackgroundJobError('INTERRUPTED');
      throw error;
    }
  },
};
