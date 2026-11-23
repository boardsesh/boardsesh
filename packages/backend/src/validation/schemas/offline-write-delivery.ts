import { z } from 'zod';
import { OFFLINE_WRITE_OBSERVATION_BATCH_LIMIT } from '@boardsesh/shared-schema';

const releaseString = z.string().max(200).nullable();
const timestamp = z.string().datetime({ offset: true });
export const OfflineWriteReleaseSchema = z
  .object({
    applicationId: releaseString.optional().transform((candidate) => candidate ?? null),
    platform: z.enum(['ios', 'android', 'unknown']),
    appVersion: releaseString,
    runtimeVersion: releaseString,
    updateId: releaseString,
    isEmbedded: z.boolean().nullable(),
    branch: releaseString,
  })
  .strict();

const tableOperations = {
  board_climbs: ['create', 'update'],
  boardsesh_ticks: ['create', 'update', 'delete'],
  user_favorites: ['create', 'delete'],
  playlists: ['create', 'update', 'delete'],
  playlist_climbs: ['create', 'delete'],
  user_follows: ['create', 'delete'],
  setter_follows: ['create', 'delete'],
  playlist_follows: ['create', 'delete'],
  user_playlist_pins: ['create', 'delete'],
  session_workouts: ['create'],
} as const;

export const OfflineWriteObservationSchema = z
  .object({
    deliveryId: z.string().uuid(),
    tableName: z.enum(
      Object.keys(tableOperations) as [keyof typeof tableOperations, ...(keyof typeof tableOperations)[]],
    ),
    operation: z.enum(['create', 'update', 'delete']),
    queuedAt: timestamp,
    connectivityReason: z.enum(['device_offline', 'backend_unreachable', 'offline_mode', 'online', 'unknown']),
    originRelease: OfflineWriteReleaseSchema,
    state: z.enum(['pending', 'dead_letter', 'finalized', 'reconciled', 'superseded', 'discarded']),
    observedAt: timestamp,
    revision: z.number().int().positive().max(2_147_483_647),
    recovered: z.boolean(),
    serverResponseAt: timestamp.nullish().transform((candidate) => candidate ?? null),
    reconciledAt: timestamp.nullish().transform((candidate) => candidate ?? null),
    firstDeadLetterAt: timestamp.nullish().transform((candidate) => candidate ?? null),
    lastDeadLetterAt: timestamp.nullish().transform((candidate) => candidate ?? null),
    observedRelease: OfflineWriteReleaseSchema.nullish().transform((candidate) => candidate ?? undefined),
  })
  .strict()
  .superRefine((observation, context) => {
    const allowedOperations: readonly string[] = tableOperations[observation.tableName];
    if (!allowedOperations.includes(observation.operation)) {
      context.addIssue({ code: 'custom', path: ['operation'], message: 'Unsupported queued operation' });
    }
    if (observation.state === 'reconciled' && observation.reconciledAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['reconciledAt'],
        message: 'Reconciliation requires a matching stage timestamp',
      });
    }
  });

export const RecordOfflineWriteObservationsInputSchema = z
  .object({
    ownerUserId: z.string().min(1).max(200),
    observations: z.array(OfflineWriteObservationSchema).min(1).max(OFFLINE_WRITE_OBSERVATION_BATCH_LIMIT),
  })
  .strict();
