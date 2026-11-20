import { z } from 'zod';
import { logger } from '../../utils/logger';
import { BOARD_WIDE_FAN_OUT_DEADLINE_SECONDS, QUANTUM_CATALOG_SYNC_BUDGET } from './fan-out-budget';
import type { BackgroundJobFamilyModule } from './types';

/** Catalog acquisition runs outside a transaction; every write uses the attempt fence. */
export const quantumCatalogSyncFamily: BackgroundJobFamilyModule<Record<string, never>> = {
  name: 'quantum-catalog-sync',
  roles: ['routine-provider'],
  payload: z.object({}).strict(),
  singletonKey: () => 'quantum',
  options: {
    ...QUANTUM_CATALOG_SYNC_BUDGET,
    retryBackoff: true,
    retryDelayMax: QUANTUM_CATALOG_SYNC_BUDGET.retryDelay,
    deadlineSeconds: BOARD_WIDE_FAN_OUT_DEADLINE_SECONDS,
    heartbeatSeconds: 300,
    priority: 0,
  },
  schedules: [{ key: 'every-6h', cron: '43 */6 * * *', fanOut: async () => [{ payload: {} }] }],
  async execute(context) {
    const { syncQuantumCatalogOnce } = await import('../../services/quantum-catalog-sync');
    await syncQuantumCatalogOnce({
      database: context.database,
      transaction: (run) => context.transaction(run),
      signal: context.signal,
      log: (message) => logger.info(message, { runId: context.runId, family: context.family }),
    });
  },
};
