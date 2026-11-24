import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgSequence, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { userBoards } from './boards';
import { playlists } from './playlists';

/** One staff-selected comparison collection per actual board configuration. */
export const gymBoardGradeCollections = pgTable('gym_board_grade_collections', {
  boardId: bigint('board_id', { mode: 'number' })
    .primaryKey()
    .references(() => userBoards.id, { onDelete: 'cascade' }),
  playlistId: bigint('playlist_id', { mode: 'bigint' }).references(() => playlists.id, { onDelete: 'set null' }),
});

export const sprayExposureEventSequence = pgSequence('spray_exposure_event_seq', { cache: 1 });

const sequenceId = () =>
  bigint('seq', { mode: 'bigint' })
    .primaryKey()
    .default(sql`nextval('public.spray_exposure_event_seq')`);
const observedAt = () => timestamp('observed_at', { withTimezone: true, mode: 'string' }).notNull();

const wallBinding = () => ({
  boardId: bigint('board_id', { mode: 'number' }).notNull(),
  boardUuid: text('board_uuid').notNull(),
  gymId: bigint('gym_id', { mode: 'number' }).notNull(),
  wallId: bigint('wall_id', { mode: 'number' }).notNull(),
  versionId: bigint('version_id', { mode: 'number' }).notNull(),
  layoutId: integer('layout_id').notNull(),
  angle: integer().notNull(),
});

/** Transactional change evidence. An invalidation cannot open an exposure interval. */
export const sprayExposureInvalidations = pgTable(
  'spray_exposure_invalidations',
  {
    seq: sequenceId(),
    kind: text().notNull(),
    key: text().notNull(),
    observedAt: observedAt(),
  },
  (table) => [index('spray_exposure_invalidation_key_idx').on(table.kind, table.key, table.seq)],
);

/** Positive eligibility evidence from a coherent, fenced, committed-state observation. */
export const sprayExposureObservations = pgTable(
  'spray_exposure_observations',
  {
    ...wallBinding(),
    seq: sequenceId(),
    climbUuid: text('climb_uuid').notNull(),
    observedAt: observedAt(),
  },
  (table) => [
    index('spray_exposure_observation_variant_idx').on(
      table.boardId,
      table.wallId,
      table.layoutId,
      table.climbUuid,
      table.angle,
      table.seq,
    ),
  ],
);

/** If a dirty edge is still in flight, an existing opening extends only to this verified time. */
export const sprayExposureCheckpoints = pgTable(
  'spray_exposure_checkpoints',
  { ...wallBinding(), observedAt: observedAt() },
  (table) => [
    primaryKey({
      columns: [
        table.boardId,
        table.boardUuid,
        table.gymId,
        table.wallId,
        table.versionId,
        table.layoutId,
        table.angle,
      ],
      name: 'spray_exposure_checkpoint_binding_pk',
    }),
  ],
);
