import { z } from 'zod';
import { logger } from '../../utils/logger';
import type { BackgroundJobFamilyModule } from './types';

const moonBoardLocationsSyncPayload = z.object({}).strict();

export type MoonBoardLocationsSyncPayload = z.infer<typeof moonBoardLocationsSyncPayload>;

/**
 * MoonBoard's public gyms, daily (#3863). Logs in with the operator's MoonBoard
 * account (`MOONBOARD_USERNAME` / `MOONBOARD_PASSWORD`), reads the map markers,
 * then writes gyms and boards through `@boardsesh/location-sync` in fenced
 * batches of 25 gyms. Each gym resolves through its alias, else the name +
 * location physical match, which is how the first run adopts the seeded gyms
 * instead of minting duplicates (docs/moonboard-sync.md).
 *
 * Without credentials the run succeeds as a logged
 * `MOONBOARD_CREDENTIALS_ABSENT` and writes nothing at all: no gym, no alias,
 * no freshness marker. A missing secret must read as "skipped", never as a
 * fresh sync. The ledger's run row (status `succeeded`, no rows touched) and
 * the log line are the visible record.
 */
export const moonBoardLocationsSyncFamily: BackgroundJobFamilyModule<MoonBoardLocationsSyncPayload> = {
  name: 'moonboard-locations-sync',
  roles: ['routine-provider'],
  options: {
    expireInSeconds: 1800,
    retryLimit: 1,
    retryDelay: 600,
    retryBackoff: true,
    retryDelayMax: 600,
    deadlineSeconds: 86400,
    // Equal to the routine cycle, so FIFO order keeps it from waiting behind
    // an endless stream of cycles (docs/background-workers.md, "Queue share").
    priority: 0,
    // One 25-gym batch (about 25 gym resolutions and 225 board upserts) holds
    // the run-row lock at a time.
    heartbeatSeconds: 120,
  },
  payload: moonBoardLocationsSyncPayload,
  singletonKey: () => 'moonboard',
  schedules: [{ key: 'daily', cron: '41 3 * * *', fanOut: async () => [{ payload: {} }] }],
  async execute(context) {
    const logContext = { runId: context.runId, family: context.family };
    const username = process.env.MOONBOARD_USERNAME?.trim();
    const password = process.env.MOONBOARD_PASSWORD;
    if (!username || !password) {
      logger.warn('[worker] moonboard locations skipped', { ...logContext, code: 'MOONBOARD_CREDENTIALS_ABSENT' });
      return;
    }
    // Loaded here, not at module scope; see loadProviderSyncAdapter.
    const { syncMoonBoardLocations } = await import('@boardsesh/moonboard-sync/sync');
    const summary = await syncMoonBoardLocations({
      db: context.database,
      transaction: context.transaction,
      signal: context.signal,
      username,
      password,
      log: (message) => logger.debug(message, logContext),
    });
    logger.info('[worker] moonboard locations finished', {
      ...logContext,
      boardsSeen: summary.boardsSeen,
      boardsUpserted: summary.boardsUpserted,
      boardsSkipped: summary.boardsSkipped,
      gymsSeen: summary.gymsSeen,
      gymsUpserted: summary.gymsUpserted,
    });
  },
};
