import { sql, type SQL } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import type { GymReportingScope, GymReportingTransaction } from './gym-reporting';
import {
  activeSprayInventorySql,
  boundedSprayLayoutSql,
  GYM_INVENTORY_MAX_REFS,
  sprayInventoryBindingExistsSql,
  sprayInventoryClimbCondition,
  type SprayInventoryBinding,
} from './gym-inventory';
import { requireGymEditAccess } from './gyms';

const SEED_VARIANTS = 128;
const SEED_WALLS = 4;
const SEED_BUDGET_MS = 750;
const MAX_OPENINGS_PER_VARIANT = 1_024;
const MAX_OPENINGS_TOTAL = 16_384;

const BINDING_COLUMNS = sql`board_id, board_uuid, gym_id, wall_id, version_id, layout_id, angle`;
const bindingValues = (binding: SprayInventoryBinding) =>
  sql`${binding.boardId}::bigint, ${binding.boardUuid}::text, ${binding.gymId}::bigint, ${binding.wallId}::bigint,
    ${binding.versionId}::bigint, ${binding.layoutId}::int, ${binding.angle}::int`;
const iso = (expression: SQL) => sql`to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The observation binds the exact current version. Other draft/version keys do not match. */
function dependencyKeys(observation: string): SQL {
  const ref = sql.identifier(observation);
  return sql`(VALUES
    ('board', ${ref}.board_uuid),
    ('policy', ${ref}.board_uuid),
    ('wall', ${ref}.wall_id::text),
    ('version', ${ref}.version_id::text),
    ('layout', public.spray_exposure_climb_key(${ref}.layout_id, ${ref}.climb_uuid))
  )`;
}

function firstInvalidationSql(): SQL {
  return sql`
    SELECT min(first_dirty.observed_at)
    FROM ${dependencyKeys('opening')} AS dependency(kind, key)
    CROSS JOIN LATERAL (
      SELECT observed_at FROM spray_exposure_invalidations event
      WHERE event.kind = dependency.kind AND event.key = dependency.key AND event.seq > opening.seq
      ORDER BY event.seq ASC LIMIT 1
    ) first_dirty
  `;
}

function observationStillOpenSql(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${dependencyKeys('opening')} AS dependency(kind, key)
    CROSS JOIN LATERAL (
      SELECT 1 FROM spray_exposure_invalidations event
      WHERE event.kind = dependency.kind AND event.key = dependency.key AND event.seq > opening.seq
      LIMIT 1
    ) dirty
  )`;
}

function bindingEquals(left: string, right: string): SQL {
  const first = sql.identifier(left);
  const second = sql.identifier(right);
  return sql`(${first}.board_id, ${first}.board_uuid, ${first}.gym_id, ${first}.wall_id, ${first}.version_id,
               ${first}.layout_id, ${first}.angle)
    = (${second}.board_id, ${second}.board_uuid, ${second}.gym_id, ${second}.wall_id, ${second}.version_id,
       ${second}.layout_id, ${second}.angle)`;
}

async function tryObserveSprayWall(scope: GymReportingScope, binding: SprayInventoryBinding): Promise<boolean> {
  return db.transaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', '150ms', true), set_config('lock_timeout', '25ms', true)`,
      );
      const [fences] = rowsFromResult<{ board: boolean; wall: boolean; version: boolean; layout: boolean }>(
        await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(public.spray_exposure_fence_key('board', ${binding.boardUuid})) AS board,
        pg_try_advisory_xact_lock(public.spray_exposure_fence_key('wall', ${String(binding.wallId)})) AS wall,
        pg_try_advisory_xact_lock(public.spray_exposure_fence_key('version', ${String(binding.versionId)})) AS version,
        pg_try_advisory_xact_lock(public.spray_exposure_fence_key('layout', ${String(binding.layoutId)})) AS layout
    `),
      );
      if (!Object.values(fences).every((held) => held === true)) return false;

      // The advisory-lock statement can hold an older snapshot. Both reads below
      // use a new READ COMMITTED statement after every fence was acquired.
      const gym = await requireGymEditAccess(scope.gym.uuid, scope.viewerId, tx);
      if (gym.id !== binding.gymId) return false;
      await tx.execute(sql`
      WITH binding(${BINDING_COLUMNS}) AS MATERIALIZED (VALUES (${bindingValues(binding)})),
      confirmed AS MATERIALIZED (
        SELECT binding.*, clock_timestamp() AS observed_at FROM binding
        WHERE ${sprayInventoryBindingExistsSql(binding, scope.viewerId)}
      ),
      previously_timed AS MATERIALIZED (
        SELECT checkpoint.observed_at FROM spray_exposure_checkpoints checkpoint JOIN confirmed ON
          ${bindingEquals('checkpoint', 'confirmed')}
      ),
      requested_now AS MATERIALIZED (
        SELECT confirmed.* FROM confirmed
        WHERE NOT EXISTS (SELECT 1 FROM previously_timed WHERE observed_at > confirmed.observed_at)
      ),
      raw_layout AS MATERIALIZED (${boundedSprayLayoutSql(binding.layoutId)}),
      eligible_climbs AS MATERIALIZED (
        SELECT board_climbs.uuid FROM raw_layout board_climbs
        WHERE (SELECT count(*) FROM raw_layout) <= ${GYM_INVENTORY_MAX_REFS}
          AND ${sprayInventoryClimbCondition(binding.layoutId)}
      ),
      pending AS MATERIALIZED (
        SELECT eligible_climbs.uuid AS climb_uuid
        FROM requested_now CROSS JOIN eligible_climbs
        WHERE NOT EXISTS (
            SELECT 1 FROM LATERAL (
              SELECT latest.* FROM spray_exposure_observations latest
              WHERE latest.board_id = requested_now.board_id AND latest.wall_id = requested_now.wall_id
                AND latest.layout_id = requested_now.layout_id AND latest.climb_uuid = eligible_climbs.uuid
                AND latest.angle = requested_now.angle
              ORDER BY latest.seq DESC LIMIT 1
            ) opening
            WHERE ${bindingEquals('opening', 'requested_now')} AND ${observationStillOpenSql()}
          )
        ORDER BY eligible_climbs.uuid LIMIT ${SEED_VARIANTS}
      ),
      opened AS (
        INSERT INTO spray_exposure_observations (${BINDING_COLUMNS}, climb_uuid, observed_at)
        SELECT ${BINDING_COLUMNS}, pending.climb_uuid, requested_now.observed_at
        FROM requested_now CROSS JOIN pending
        RETURNING seq
      )
      INSERT INTO spray_exposure_checkpoints (${BINDING_COLUMNS}, observed_at)
      SELECT requested_now.* FROM requested_now
      WHERE (SELECT count(*) FROM raw_layout) <= ${GYM_INVENTORY_MAX_REFS}
        AND (EXISTS (SELECT 1 FROM opened) OR NOT EXISTS (
          SELECT 1 FROM previously_timed WHERE observed_at > requested_now.observed_at - interval '60 seconds'
        ))
      ON CONFLICT (${BINDING_COLUMNS}) DO UPDATE SET observed_at = excluded.observed_at
    `);
      return true;
    },
    { isolationLevel: 'read committed' },
  );
}

export async function chooseSprayObservationBindings(
  tx: GymReportingTransaction,
  bindings: readonly SprayInventoryBinding[],
): Promise<SprayInventoryBinding[]> {
  if (bindings.length === 0) return [];
  const rows = rowsFromResult<{ id: number }>(
    await tx.execute(sql`
    WITH requested(${BINDING_COLUMNS}) AS (VALUES ${sql.join(
      bindings.map((binding) => sql`(${bindingValues(binding)})`),
      sql`, `,
    )})
    SELECT requested.board_id::double precision AS id FROM requested
    LEFT JOIN spray_exposure_checkpoints checkpoint ON ${bindingEquals('checkpoint', 'requested')}
    ORDER BY checkpoint.observed_at NULLS FIRST, requested.board_id
  `),
  );
  const byId = new Map(bindings.map((binding) => [binding.boardId, binding]));
  return rows.flatMap(({ id }) => {
    const binding = byId.get(id);
    return binding ? [binding] : [];
  });
}

export async function observeSprayInventory(
  scope: GymReportingScope,
  bindings: readonly SprayInventoryBinding[],
): Promise<void> {
  const deadline = Date.now() + SEED_BUDGET_MS;
  let measuredWalls = 0;
  for (const binding of bindings) {
    if (measuredWalls >= SEED_WALLS || Date.now() >= deadline) break;
    try {
      if (await tryObserveSprayWall(scope, binding)) measuredWalls++;
    } catch (error) {
      // Measurement is optional evidence. A failed or revoked seed never adds
      // exposure and cannot turn a permitted live inventory into a false result.
      logger.debug('Spray inventory observation unavailable', {
        wallId: binding.wallId,
        code: (error as { code?: string } | undefined)?.code,
      });
    }
  }
}

function boundedOpeningsSql(scope: GymReportingScope, bindings: readonly SprayInventoryBinding[]): SQL {
  if (bindings.length === 0) return sql`SELECT * FROM spray_exposure_observations WHERE false`;
  return sql`
    WITH bindings(${BINDING_COLUMNS}) AS (VALUES ${sql.join(
      bindings.map((binding) => sql`(${bindingValues(binding)})`),
      sql`, `,
    )})
    SELECT opening.* FROM (${activeSprayInventorySql(bindings)}) active
    JOIN bindings binding ON binding.board_id = active.board_id
    CROSS JOIN LATERAL (
      SELECT observation.* FROM spray_exposure_observations observation
      WHERE observation.board_id = active.board_id AND observation.layout_id = active.layout_id
        AND observation.wall_id = binding.wall_id AND observation.board_uuid = binding.board_uuid
        AND observation.climb_uuid = active.climb_uuid
        AND observation.angle = active.angle
        AND observation.gym_id IN (${sql.join(
          scope.canonicalGymIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND observation.observed_at <= ${scope.asOf}::timestamptz
      ORDER BY observation.seq LIMIT ${MAX_OPENINGS_PER_VARIANT + 1}
    ) opening
    LIMIT ${MAX_OPENINGS_TOTAL + 1}
  `;
}

/** #7970 may fail independently when exposure is too large. Current membership is still available. */
export async function assertSprayExposureBounded(
  tx: GymReportingTransaction,
  scope: GymReportingScope,
  bindings: readonly SprayInventoryBinding[],
): Promise<void> {
  const [row] = rowsFromResult<{ total: number; perVariant: number }>(
    await tx.execute(sql`
    SELECT coalesce(sum(num), 0)::int AS total, coalesce(max(num), 0)::int AS "perVariant"
    FROM (
      SELECT count(*) AS num FROM (${boundedOpeningsSql(scope, bindings)}) opening
      GROUP BY board_id, layout_id, wall_id, climb_uuid, angle
    ) variants
  `),
  );
  if (row.total > MAX_OPENINGS_TOTAL || row.perVariant > MAX_OPENINGS_PER_VARIANT) {
    throw new GraphQLError('Spray exposure is unavailable at this scope', {
      extensions: { code: 'EXPOSURE_UNAVAILABLE' },
    });
  }
}

/** Use only after the cap probe, in the same snapshot, with the same sanitized bindings. */
export function sprayExposureIntervalsSql(scope: GymReportingScope, bindings: readonly SprayInventoryBinding[]): SQL {
  return sql`
    WITH openings AS MATERIALIZED (${boundedOpeningsSql(scope, bindings)}),
    stopped AS MATERIALIZED (
      SELECT opening.*, least(coalesce(dirty.at, checkpoint.observed_at), ${scope.asOf}::timestamptz) AS end_at
      FROM openings opening
      LEFT JOIN LATERAL (${firstInvalidationSql()}) dirty(at) ON true
      LEFT JOIN spray_exposure_checkpoints checkpoint ON ${bindingEquals('checkpoint', 'opening')}
      WHERE dirty.at IS NOT NULL OR checkpoint.observed_at IS NOT NULL
    ),
    checked AS (
      SELECT *, lag(end_at) OVER variant AS preceding_end FROM stopped
      WINDOW variant AS (PARTITION BY board_id, wall_id, layout_id, climb_uuid, angle ORDER BY seq)
    ),
    measured AS (
      SELECT board_id, wall_id, layout_id, climb_uuid, angle,
        range_agg(CASE WHEN end_at > observed_at THEN tstzrange(observed_at, end_at, '[)') END) AS ranges
      FROM checked GROUP BY board_id, wall_id, layout_id, climb_uuid, angle
      -- The first opening has no preceding range. It still proves exposure.
      HAVING NOT bool_or(end_at < observed_at OR coalesce(preceding_end > observed_at, false))
    )
    SELECT board_id, wall_id, layout_id, climb_uuid, angle, lower(known) AS start_at, upper(known) AS end_at
    FROM measured CROSS JOIN LATERAL unnest(ranges) known
  `;
}

/** #7970 can also join the raw ranges above to prove timed send containment. */
export function sprayExposureSummarySql(scope: GymReportingScope, bindings: readonly SprayInventoryBinding[]): SQL {
  return sql`
    SELECT board_id, wall_id, layout_id, climb_uuid, angle,
      ${iso(sql`min(start_at)`)} AS "firstKnownAvailableAt",
      ${iso(sql`max(start_at)`)} AS "lastKnownAvailableSince",
      ${iso(sql`max(end_at)`)} AS "confirmedThrough",
      sum(extract(epoch FROM (end_at - start_at)))::double precision AS "knownLifetimeSeconds",
      sum(greatest(0, extract(epoch FROM (least(end_at, ${scope.current.endAt}::timestamptz)
        - greatest(start_at, ${scope.current.startAt}::timestamptz)))))::double precision AS "knownWindowSeconds"
    FROM (${sprayExposureIntervalsSql(scope, bindings)}) eligible_ranges
    GROUP BY board_id, wall_id, layout_id, climb_uuid, angle
  `;
}
