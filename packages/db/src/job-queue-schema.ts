import { PgBoss } from 'pg-boss';
import {
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_DEAD_QUEUE,
  SPRAY_DETECTION_RECONCILE_QUEUE,
  SPRAY_DETECTION_JOB_OPTIONS,
} from '@boardsesh/shared-schema';
import {
  BACKGROUND_JOB_QUEUES,
  BACKGROUND_JOB_QUEUE_OPTIONS,
  BACKGROUND_JOB_RECONCILE_QUEUE,
  BACKGROUND_SCHEDULE_QUEUE,
  BACKGROUND_SCHEDULE_QUEUE_OPTIONS,
  BACKGROUND_WORKER_ROLES,
  jobQueueTransactionAdapter,
  type BackgroundWorkerRole,
} from './background-jobs';

/**
 * The backend's daily popular-board-configs refresh (and the refresh a reader's
 * cache miss asks for). Lives here because the migrator creates the queue.
 */
export const POPULAR_BOARD_CONFIGS_REFRESH_QUEUE = 'popular-board-configs-refresh';

/**
 * `exclusive`: one job queued or running, so the cron and any number of on-miss
 * requests collapse to one. A run takes about 30 s; expiry at 600 s sits under
 * the backend's 900 s Redis lock, so a retry after an expiry finds the lock
 * still held by the stuck run and skips instead of running a second copy.
 */
const POPULAR_BOARD_CONFIGS_REFRESH_QUEUE_OPTIONS = {
  policy: 'exclusive',
  expireInSeconds: 600,
  retryLimit: 2,
  retryDelay: 300,
} as const;

/**
 * The backend's hourly `board_climb_popularity` refresh (the popular sort's
 * ranking table, docs/climb-popularity.md). Lives here because the migrator
 * creates the queue.
 */
export const CLIMB_POPULARITY_REFRESH_QUEUE = 'climb-popularity-refresh';

/**
 * `exclusive`: one job queued or running, so a slow run never overlaps the
 * next hour's. An incremental run takes well under a second; a full pass
 * (a board's first build, then weekly) took 34 s for every board on the dev DB.
 * The handler stops itself before 1,500 s, under this expiry, so pg-boss never
 * starts a second copy beside a live one.
 */
const CLIMB_POPULARITY_REFRESH_QUEUE_OPTIONS = {
  policy: 'exclusive',
  expireInSeconds: 1_800,
  retryLimit: 2,
  retryDelay: 300,
} as const;

/**
 * Completed jobs of the once-a-minute crons (the two reconcilers and pg-boss's
 * own `__pgboss__send-it` dispatcher) are kept 1 day, not pg-boss's 7-day
 * default. The queue-stats monitor seq-scans this table on every pass.
 */
export const CRON_JOB_DELETE_AFTER_SECONDS = 24 * 60 * 60;

type TablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/** One GRANT on a `public` table, optionally limited to some columns. */
export type WorkerTableGrant = {
  table: string;
  privileges: readonly TablePrivilege[];
  columns?: readonly string[];
};

/**
 * What syncing one climber's Aurora or Kilter account reads and writes: the
 * credential bookkeeping and fences, then everything the two user-sync
 * appliers touch (`apply-user-logbook.ts`, aurora `user-sync.ts`, kilter
 * `user-sync.ts`, and the stats recompute they both call).
 */
const PROVIDER_SYNC_WRITE: readonly TablePrivilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const PROVIDER_SYNC_GRANTS: readonly WorkerTableGrant[] = [
  // Status, token and failure bookkeeping on the credential; the link
  // generation, lease and pending run on the control row. Rows are never
  // created or deleted by a worker: linking and unlinking are the backend's.
  { table: 'aurora_credentials', privileges: ['SELECT', 'UPDATE'] },
  { table: 'provider_sync_controls', privileges: ['SELECT', 'UPDATE'] },
  // Read only: the name the stats recompute crowns a climb's first
  // ascensionist with (COALESCE(display_name, name)), and nothing else of the
  // user: no email, no image. Then the board mapping, and the climb aliases
  // both appliers resolve canonical climbs through.
  { table: 'users', privileges: ['SELECT'], columns: ['id', 'name'] },
  { table: 'user_profiles', privileges: ['SELECT'], columns: ['user_id', 'display_name'] },
  { table: 'user_board_mappings', privileges: ['SELECT'] },
  { table: 'board_climb_aliases', privileges: ['SELECT'] },
  // The logbook and its skip log.
  { table: 'boardsesh_ticks', privileges: PROVIDER_SYNC_WRITE },
  { table: 'logbook_sync_skips', privileges: PROVIDER_SYNC_WRITE },
  // Aurora's per-user tables and the incremental sync cursor.
  { table: 'board_users', privileges: PROVIDER_SYNC_WRITE },
  { table: 'board_walls', privileges: PROVIDER_SYNC_WRITE },
  { table: 'board_climbs', privileges: PROVIDER_SYNC_WRITE },
  { table: 'board_tags', privileges: PROVIDER_SYNC_WRITE },
  { table: 'board_circuits', privileges: PROVIDER_SYNC_WRITE },
  { table: 'board_user_syncs', privileges: PROVIDER_SYNC_WRITE },
  // The stats recompute after a logbook write, and Kilter's ratings.
  { table: 'board_climb_stats', privileges: PROVIDER_SYNC_WRITE },
  { table: 'board_climb_ratings', privileges: PROVIDER_SYNC_WRITE },
  // Circuits mirrored as playlists.
  { table: 'playlists', privileges: PROVIDER_SYNC_WRITE },
  { table: 'playlist_climbs', privileges: PROVIDER_SYNC_WRITE },
  { table: 'playlist_ownership', privileges: PROVIDER_SYNC_WRITE },
  // Written by the boardsesh_ticks and playlist* delete triggers (offline sync tombstones).
  { table: 'sync_deletions', privileges: ['INSERT'] },
  // The stats keys a page or flush still owes a recompute: marked (upsert) in
  // the page transaction, locked, recomputed and deleted in the batch after it.
  { table: 'climb_stats_recompute_pending', privileges: PROVIDER_SYNC_WRITE },
];

const CATALOG_WRITE: readonly TablePrivilege[] = ['SELECT', 'INSERT', 'UPDATE'];

/**
 * What the routine-provider role's board-wide families write on top of a user
 * sync: the Aurora shared sync (aurora-sync `shared-sync.ts`, via
 * `db/table-select.ts`), the Kilter catalog sync with its deletions, stats
 * repair and history snapshot (kilter-sync `catalog-*.ts`, `deletions.ts`,
 * `stats-repair.ts`), and the public location syncs for Aurora, Kilter and
 * MoonBoard (`@boardsesh/location-sync`'s `upsert.ts`, the gym-wall crawl).
 */
const ROUTINE_PROVIDER_EXTRA_GRANTS: readonly WorkerTableGrant[] = [
  // The routine cycle creates the control row of a credential linked before
  // control rows existed (ON CONFLICT DO NOTHING, no new generation), so it can
  // fence that account's batches like any other.
  { table: 'provider_sync_controls', privileges: ['INSERT'] },
  // Aurora's shared catalog tables.
  { table: 'board_products', privileges: CATALOG_WRITE },
  { table: 'board_sets', privileges: CATALOG_WRITE },
  { table: 'board_product_sizes', privileges: CATALOG_WRITE },
  { table: 'board_holes', privileges: CATALOG_WRITE },
  { table: 'board_layouts', privileges: CATALOG_WRITE },
  { table: 'board_placement_roles', privileges: CATALOG_WRITE },
  { table: 'board_leds', privileges: CATALOG_WRITE },
  { table: 'board_placements', privileges: CATALOG_WRITE },
  { table: 'board_product_sizes_layouts_sets', privileges: CATALOG_WRITE },
  { table: 'board_beta_links', privileges: CATALOG_WRITE },
  { table: 'board_attempts', privileges: CATALOG_WRITE },
  { table: 'board_kits', privileges: CATALOG_WRITE },
  { table: 'board_climb_holds', privileges: CATALOG_WRITE },
  // Aurora's per-table cursors, the shared-sync and catalog cooldown slots and
  // the weekly repair and snapshot watermarks.
  { table: 'board_shared_syncs', privileges: CATALOG_WRITE },
  { table: 'board_climb_stats_history', privileges: ['SELECT', 'INSERT'] },
  // Kilter's catalog: folded aliases (and the deletions that drop them), the
  // layout map, and the backlog of climbs it could not ingest.
  { table: 'board_climb_aliases', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'board_layout_aliases', privileges: CATALOG_WRITE },
  { table: 'board_climb_ingest_skips', privileges: CATALOG_WRITE },
  // "New climbs from a setter you follow": who follows whom, and the notification.
  { table: 'setter_follows', privileges: ['SELECT'] },
  { table: 'user_follows', privileges: ['SELECT'] },
  { table: 'notifications', privileges: ['SELECT', 'INSERT'] },
  // Public gym and board locations.
  { table: 'gyms', privileges: CATALOG_WRITE },
  { table: 'user_boards', privileges: CATALOG_WRITE },
  { table: 'location_sync_gym_sources', privileges: CATALOG_WRITE },
  { table: 'kilter_wall_sources', privileges: CATALOG_WRITE },
  // Read only: the physical gym match weighs a candidate by its claims,
  // members, followers and comments before adopting it.
  { table: 'gym_claims', privileges: ['SELECT'] },
  { table: 'gym_members', privileges: ['SELECT'] },
  { table: 'gym_follows', privileges: ['SELECT'] },
  { table: 'comments', privileges: ['SELECT'], columns: ['entity_id', 'entity_type', 'deleted_at'] },
  // The system user that owns public catalog boards, created on first use
  // (ON CONFLICT DO NOTHING). Drizzle names every column of the table in the
  // INSERT, defaults included, so each needs the column grant; none is readable.
  {
    table: 'users',
    privileges: ['INSERT'],
    columns: ['id', 'name', 'email', 'emailVerified', 'image', 'created_at', 'updated_at'],
  },
];

/**
 * What `climb-stats-self-heal` reads and writes: the stale-key scan and the
 * bulk recompute (`climb-stats/self-heal.ts`, `recompute.ts`). Column grants
 * keep the tick notes, comments and the rest of a climber's row out of reach.
 */
const CLIMB_STATS_SELF_HEAL_GRANTS: readonly WorkerTableGrant[] = [
  {
    table: 'boardsesh_ticks',
    privileges: ['SELECT'],
    columns: [
      'id',
      'user_id',
      'board_type',
      'climb_uuid',
      'angle',
      'status',
      'origin',
      'quality',
      'difficulty',
      'climbed_at',
      'updated_at',
      'kilter_id',
      'kilter_synced_at',
      'kilter_detached_at',
    ],
  },
  { table: 'board_climbs', privileges: ['SELECT'], columns: ['uuid', 'board_type', 'user_id'] },
  { table: 'board_climb_stats', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  // Pending keys a stopped worker left behind: read `FOR UPDATE SKIP LOCKED`
  // (which needs UPDATE), recomputed, deleted. The tick scan's recompute also
  // upserts a marker for each of its keys first (INSERT) to hold its lock.
  { table: 'climb_stats_recompute_pending', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  // The first ascensionist's crown: COALESCE(display_name, name).
  { table: 'users', privileges: ['SELECT'], columns: ['id', 'name'] },
  { table: 'user_profiles', privileges: ['SELECT'], columns: ['user_id', 'display_name'] },
];

/** Personal archives: selected climbing fields only, with no credentials or catalogue writes. */
const USER_DATA_EXPORT_GRANTS: readonly WorkerTableGrant[] = [
  { table: 'users', privileges: ['SELECT'], columns: ['id', 'name', 'email', 'created_at'] },
  // The shared spray visibility predicate reads only access-control fields.
  { table: 'spray_walls', privileges: ['SELECT'], columns: ['board_uuid', 'layout_id', 'deleted_at', 'hidden_at'] },
  { table: 'user_boards', privileges: ['SELECT'], columns: ['uuid', 'owner_id', 'gym_id', 'is_public', 'deleted_at'] },
  { table: 'gym_members', privileges: ['SELECT'], columns: ['gym_id', 'user_id'] },
  {
    table: 'boardsesh_ticks',
    privileges: ['SELECT'],
    columns: [
      'id',
      'uuid',
      'user_id',
      'board_type',
      'climb_uuid',
      'angle',
      'status',
      'attempt_count',
      'quality',
      'difficulty',
      'comment',
      'is_mirror',
      'is_benchmark',
      'board_id',
      'session_id',
      'origin',
      'climbed_at',
      'created_at',
      'updated_at',
    ],
  },
  {
    table: 'board_climbs',
    privileges: ['SELECT'],
    columns: [
      'uuid',
      'board_type',
      'user_id',
      'name',
      'layout_id',
      'frames',
      'frames_count',
      'frames_pace',
      'angle',
      'created_at',
      'updated_at',
      'is_draft',
      'is_listed',
      'description',
      'characteristics',
    ],
  },
  { table: 'board_climb_aliases', privileges: ['SELECT'], columns: ['board_type', 'alias_uuid', 'canonical_uuid'] },
  { table: 'board_difficulty_grades', privileges: ['SELECT'], columns: ['board_type', 'difficulty', 'boulder_name'] },
  {
    table: 'user_favorites',
    privileges: ['SELECT'],
    columns: ['id', 'user_id', 'board_name', 'climb_uuid', 'angle', 'created_at', 'updated_at'],
  },
  {
    table: 'playlists',
    privileges: ['SELECT'],
    columns: [
      'id',
      'uuid',
      'board_type',
      'layout_id',
      'name',
      'color',
      'icon',
      'description',
      'is_public',
      'created_at',
      'updated_at',
    ],
  },
  { table: 'playlist_ownership', privileges: ['SELECT'], columns: ['playlist_id', 'user_id', 'role'] },
  {
    table: 'playlist_climbs',
    privileges: ['SELECT'],
    columns: ['id', 'playlist_id', 'climb_uuid', 'angle', 'position', 'added_at', 'updated_at'],
  },
];

/**
 * Data grants per worker role, on top of the pg-boss DML and the ledger every
 * worker login gets. Each list is exactly what that role's families read and
 * write, and is proven by running every family under the restricted role in
 * packages/backend/src/services/__tests__/job-queue-roles.test.ts. Sequences
 * owned by a table the role may INSERT into get USAGE. Roles whose families
 * ship later add their lists in the PR that ships them.
 */
export const WORKER_ROLE_DATA_GRANTS: Record<BackgroundWorkerRole, readonly WorkerTableGrant[]> = {
  // aurora-user-sync, kilter-user-sync.
  'interactive-import': PROVIDER_SYNC_GRANTS,
  // provider-routine-cycle (a user sync), aurora-shared-sync,
  // kilter-catalog-sync, moonboard-locations-sync.
  'routine-provider': [...PROVIDER_SYNC_GRANTS, ...ROUTINE_PROVIDER_EXTRA_GRANTS],
  // climb-stats-self-heal, user-data-export.
  'maintenance-delivery': [...CLIMB_STATS_SELF_HEAL_GRANTS, ...USER_DATA_EXPORT_GRANTS],
  // refresh-recommendations, refresh-hold-features, refresh-climb-grades,
  // refresh-climb-neighbors, export-board-snapshots.
  batch: [
    // Catalog and history the jobs scan.
    { table: 'board_climbs', privileges: ['SELECT'] },
    { table: 'board_climb_stats', privileges: ['SELECT'] },
    { table: 'board_climb_holds', privileges: ['SELECT'] },
    { table: 'board_placements', privileges: ['SELECT'] },
    { table: 'board_holes', privileges: ['SELECT'] },
    { table: 'board_sets', privileges: ['SELECT'] },
    { table: 'board_product_sizes_layouts_sets', privileges: ['SELECT'] },
    { table: 'board_climb_embeddings', privileges: ['SELECT'] },
    { table: 'board_climb_aliases', privileges: ['SELECT'] },
    // The grade model's rater and behaviour evidence: the outcome columns of
    // each tick (never comments, sessions or media), plus which gym a tick's
    // board belongs to (two columns of user_boards, nothing else).
    {
      table: 'boardsesh_ticks',
      privileges: ['SELECT'],
      columns: [
        'user_id',
        'board_type',
        'climb_uuid',
        'angle',
        'status',
        'attempt_count',
        'origin',
        'difficulty',
        'board_id',
        'climbed_at',
      ],
    },
    // Which gym a tick's board belongs to, plus the columns the weekly
    // spray-wall health roll-up folds its roster from (#6062): identity for
    // the join, ownership for the second-climber split, visibility flags for
    // the stock counts. Never names, locations, settings or coordinates.
    {
      table: 'user_boards',
      privileges: ['SELECT'],
      columns: ['id', 'gym_id', 'uuid', 'owner_id', 'board_type', 'is_public', 'created_at', 'deleted_at'],
    },
    // The spray-wall fleet the health roll-up counts: the wall roster (join
    // key, layout for climbs, hold stock, deletion/hide state), the reset
    // history, and the report queue. No photos, no versions' payloads.
    {
      table: 'spray_walls',
      privileges: ['SELECT'],
      columns: ['id', 'board_uuid', 'layout_id', 'hold_count', 'deleted_at', 'hidden_at'],
    },
    { table: 'spray_wall_versions', privileges: ['SELECT'], columns: ['wall_id', 'status', 'published_at'] },
    { table: 'spray_wall_reports', privileges: ['SELECT'], columns: ['wall_id', 'created_at'] },
    // "Lit" for a wall with no LEDs (board_climb_events): the weekly roll-up's
    // lighting side. Only the board/climb/user columns the aggregates group
    // by, and the confirmation time the window filters on.
    {
      table: 'board_climb_events',
      privileges: ['SELECT'],
      columns: ['board_id', 'board_type', 'climb_uuid', 'user_id', 'confirmed_at'],
    },
    // The recommendations job's writes.
    { table: 'board_setter_stats', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: 'board_climb_send_stats', privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: 'playlists', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: 'playlist_ownership', privileges: ['SELECT', 'INSERT'] },
    { table: 'playlist_climbs', privileges: ['SELECT', 'INSERT', 'DELETE'] },
    // Written by the playlist_climbs delete trigger (offline sync tombstones).
    { table: 'sync_deletions', privileges: ['INSERT'] },
    { table: 'board_climb_stats_history', privileges: ['SELECT', 'INSERT'] },
    // The weekly history-snapshot watermark.
    { table: 'board_shared_syncs', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    // The two reserved system users. ON CONFLICT (id) reads the id; no other
    // column of users is readable or writable.
    { table: 'users', privileges: ['SELECT'], columns: ['id'] },
    { table: 'users', privileges: ['INSERT'], columns: ['id', 'name', 'email'] },
    // The hold-features job's writes.
    { table: 'board_hold_features', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: 'user_hold_classifications', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    // The grade job's writes.
    { table: 'board_climb_grades', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
    { table: 'board_grade_coefficients', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    // The neighbours job's writes: the lists, the per-board watermark and
    // build state, and the groups a full build has finished. It reads only
    // board_climbs besides these.
    { table: 'board_climb_neighbors', privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: 'board_climb_neighbor_runs', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: 'board_climb_neighbor_group_runs', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    // export-board-snapshots writes nothing. The per-layout artifacts read
    // board_climbs, board_climb_stats and board_climb_grades (above); the
    // catalogue artifact reads every CATALOG_SNAPSHOT_TABLES entry. Its deletion
    // replay observer also needs pg_read_all_stats, a predefined role this
    // migrator cannot grant: the admin grants it when provisioning the login
    // (docs/background-workers.md).
    { table: 'board_products', privileges: ['SELECT'] },
    { table: 'board_layouts', privileges: ['SELECT'] },
    { table: 'board_product_sizes', privileges: ['SELECT'] },
    { table: 'board_placement_roles', privileges: ['SELECT'] },
    { table: 'board_leds', privileges: ['SELECT'] },
    { table: 'board_kits', privileges: ['SELECT'] },
    { table: 'board_difficulty_grades', privileges: ['SELECT'] },
    { table: 'board_attempts', privileges: ['SELECT'] },
    // Every column except the three the catalogue drops
    // (CATALOG_SNAPSHOT_EXCLUDED_COLUMNS: who attached a link, and to which tick
    // and wall). The catalogue lists columns through information_schema.columns,
    // which shows only granted ones, so a new column must be added here or the
    // export silently leaves it out; job-queue-roles-snapshots.test.ts compares the
    // restricted column lists with the owner's.
    {
      table: 'board_beta_links',
      privileges: ['SELECT'],
      columns: [
        'board_type',
        'climb_uuid',
        'link',
        'foreign_username',
        'angle',
        'thumbnail',
        'is_listed',
        'created_at',
        'shortcode',
        'video_identity',
      ],
    },
  ],
};

/** The table-level ledger grant every worker login needs; its DELETE stays with the backend. */
const LEDGER_GRANT: WorkerTableGrant = {
  table: 'background_job_runs',
  privileges: ['SELECT', 'INSERT', 'UPDATE'],
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type WorkerLogin = { login: string; role?: BackgroundWorkerRole };

/**
 * Parse one `MIGRATION_WORKER_ROLES` entry: `<worker-role>=<login>` grants the
 * role's data tables, a bare `<login>` only the queue and ledger.
 */
export function parseWorkerLogin(entry: string): WorkerLogin {
  const separator = entry.indexOf('=');
  if (separator < 0) {
    if (!IDENTIFIER.test(entry)) throw new Error('Invalid job queue role');
    return { login: entry };
  }
  const role = entry.slice(0, separator);
  const login = entry.slice(separator + 1);
  if (!(BACKGROUND_WORKER_ROLES as readonly string[]).includes(role)) throw new Error('Invalid worker role');
  if (!IDENTIFIER.test(login)) throw new Error('Invalid job queue role');
  return { login, role: role as BackgroundWorkerRole };
}

/**
 * A SQL string literal (what `quote_literal` returns). Every value passed here
 * already matched IDENTIFIER; this is the second guard, not the only one.
 */
function sqlLiteral(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error('Invalid grant identifier');
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlTextArray(values: readonly string[]): string {
  return `ARRAY[${values.map(sqlLiteral).join(', ')}]::text[]`;
}

/** One GRANT, built inside PL/pgSQL with format('%I') for every identifier. */
function grantExecute(grant: WorkerTableGrant): string {
  const privileges = grant.privileges.join(', ');
  if (!/^(SELECT|INSERT|UPDATE|DELETE)(, (SELECT|INSERT|UPDATE|DELETE))*$/.test(privileges)) {
    throw new Error('Invalid grant privilege');
  }
  if (!grant.columns) {
    return `  EXECUTE format('GRANT ${privileges} ON public.%I TO %I', ${sqlLiteral(grant.table)}, grantee_name);`;
  }
  // Column grants: every listed privilege applies to the listed columns only.
  const columnList = `(SELECT string_agg(quote_ident(column_name), ', ') FROM unnest(${sqlTextArray(grant.columns)}) AS column_name)`;
  const perPrivilege = grant.privileges.map((privilege) => `${privilege} (%1$s)`).join(', ');
  return `  EXECUTE format('GRANT ${perPrivilege} ON public.%2$I TO %3$I', ${columnList}, ${sqlLiteral(grant.table)}, grantee_name);`;
}

/**
 * One login's whole grant set as a single `DO` block: one statement is one
 * transaction, so a migration that runs while a worker is mid-job never leaves
 * the login between the revoke and the grants. Inside the block every
 * identifier goes through format('%I'); the values come from validated
 * literals.
 *
 * A table-level REVOKE leaves column-level grants in place, so the block also
 * revokes each column the login holds a grant on. Without that, a login moved
 * from `batch=` to a bare entry would keep reading the tick columns.
 */
function workerGrantBlock(login: string, role: BackgroundWorkerRole | undefined): string {
  const grants = [LEDGER_GRANT, ...(role ? WORKER_ROLE_DATA_GRANTS[role] : [])];
  const insertTables = [
    ...new Set(grants.filter((grant) => grant.privileges.includes('INSERT')).map((grant) => grant.table)),
  ];
  const sequenceGrants = insertTables.length
    ? `
  -- Serial and identity columns: the sequences the inserts draw from.
  FOR owned_sequence IN
    SELECT sequence.relname
      FROM pg_depend dependency
      JOIN pg_class sequence ON sequence.oid = dependency.objid AND sequence.relkind = 'S'
      JOIN pg_class owner ON owner.oid = dependency.refobjid
      JOIN pg_namespace namespace ON namespace.oid = owner.relnamespace
     WHERE dependency.deptype IN ('a', 'i')
       AND namespace.nspname = 'public'
       AND owner.relname = ANY(${sqlTextArray(insertTables)})
  LOOP
    EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO %I', owned_sequence, grantee_name);
  END LOOP;`
    : '';
  return `DO $grants$
DECLARE
  grantee_name text := ${sqlLiteral(login)};
  owned_sequence text;
  granted_column record;
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', grantee_name);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', grantee_name);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', grantee_name);
  FOR granted_column IN
    SELECT DISTINCT relation.relname AS table_name, attribute.attname AS column_name
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
     WHERE namespace.nspname = 'public'
       AND attribute.attacl IS NOT NULL
       AND privilege.grantee = to_regrole(grantee_name)
  LOOP
    EXECUTE format('REVOKE ALL (%I) ON public.%I FROM %I', granted_column.column_name, granted_column.table_name, grantee_name);
  END LOOP;
${grants.map(grantExecute).join('\n')}${sequenceGrants}
END
$grants$`;
}

/** Only the deployment's reserved migration-owner connection may execute this. */
export async function initializeJobQueueSchema(
  database: Parameters<typeof jobQueueTransactionAdapter>[0],
  runtimeRole?: string,
  detectorRole?: string,
  workerRoles: readonly string[] = [],
): Promise<void> {
  const workerLogins = workerRoles.map(parseWorkerLogin);
  for (const role of [runtimeRole, detectorRole]) {
    if (role && !IDENTIFIER.test(role)) throw new Error('Invalid job queue role');
  }
  // A worker login's grants are revoked and rebuilt below; pointed at the
  // runtime or detector login, that would strip the backend's own CRUD.
  for (const { login } of workerLogins) {
    if (login === runtimeRole || login === detectorRole) {
      throw new Error(`Worker login ${login} must not be the runtime or detector role`);
    }
  }
  const adapter = jobQueueTransactionAdapter(database);
  const boss = new PgBoss({ db: adapter, supervise: false, schedule: false });
  boss.on('error', () => {
    /* The awaited startup/DDL operation reports failures. */
  });
  try {
    await boss.start();
    // pg-boss 12.33's scheduler creates this queue at runtime. Pre-create it
    // under the owner so scheduler startup needs DML, never schema CREATE.
    await boss.createQueue('__pgboss__send-it', { partition: false });
    await boss.updateQueue('__pgboss__send-it', { deleteAfterSeconds: CRON_JOB_DELETE_AFTER_SECONDS });
    await boss.createQueue(SPRAY_DETECTION_DEAD_QUEUE, { partition: false });
    await boss.createQueue(SPRAY_DETECTION_QUEUE, { partition: false, ...SPRAY_DETECTION_JOB_OPTIONS });
    await boss.updateQueue(SPRAY_DETECTION_QUEUE, SPRAY_DETECTION_JOB_OPTIONS);
    await boss.createQueue(SPRAY_DETECTION_RECONCILE_QUEUE, {
      partition: false,
      policy: 'singleton',
      expireInSeconds: 120,
      deleteAfterSeconds: CRON_JOB_DELETE_AFTER_SECONDS,
    });
    // createQueue leaves an existing queue's options alone, so update the
    // retention when the owner initializes an already-installed queue too.
    await boss.updateQueue(SPRAY_DETECTION_RECONCILE_QUEUE, {
      deleteAfterSeconds: CRON_JOB_DELETE_AFTER_SECONDS,
    });
    await boss.createQueue(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, {
      partition: false,
      ...POPULAR_BOARD_CONFIGS_REFRESH_QUEUE_OPTIONS,
    });
    const { policy: _popularPolicy, ...mutablePopularOptions } = POPULAR_BOARD_CONFIGS_REFRESH_QUEUE_OPTIONS;
    await boss.updateQueue(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, mutablePopularOptions);
    await boss.createQueue(CLIMB_POPULARITY_REFRESH_QUEUE, {
      partition: false,
      ...CLIMB_POPULARITY_REFRESH_QUEUE_OPTIONS,
    });
    const { policy: _climbPopularityPolicy, ...mutableClimbPopularityOptions } = CLIMB_POPULARITY_REFRESH_QUEUE_OPTIONS;
    await boss.updateQueue(CLIMB_POPULARITY_REFRESH_QUEUE, mutableClimbPopularityOptions);
    // Family queues are stately. A queue created under an earlier policy keeps
    // it (pg-boss cannot change a policy), which is why these are new names
    // rather than the retired `background-probe-<role>` queues.
    const { policy: _familyPolicy, ...mutableFamilyOptions } = BACKGROUND_JOB_QUEUE_OPTIONS;
    for (const queue of Object.values(BACKGROUND_JOB_QUEUES)) {
      await boss.createQueue(queue, { partition: false, ...BACKGROUND_JOB_QUEUE_OPTIONS });
      await boss.updateQueue(queue, mutableFamilyOptions);
    }
    await boss.createQueue(BACKGROUND_SCHEDULE_QUEUE, { partition: false, ...BACKGROUND_SCHEDULE_QUEUE_OPTIONS });
    const { policy: _schedulePolicy, ...mutableScheduleOptions } = BACKGROUND_SCHEDULE_QUEUE_OPTIONS;
    await boss.updateQueue(BACKGROUND_SCHEDULE_QUEUE, mutableScheduleOptions);
    // The reconcile pass has always run under a 120 s lease; keep it.
    const reconcileOptions = {
      ...BACKGROUND_JOB_QUEUE_OPTIONS,
      expireInSeconds: 120,
      policy: 'singleton' as const,
      deleteAfterSeconds: CRON_JOB_DELETE_AFTER_SECONDS,
    };
    await boss.createQueue(BACKGROUND_JOB_RECONCILE_QUEUE, { partition: false, ...reconcileOptions });
    const { policy: _reconcilePolicy, ...mutableReconcileOptions } = reconcileOptions;
    await boss.updateQueue(BACKGROUND_JOB_RECONCILE_QUEUE, mutableReconcileOptions);
    for (const role of [runtimeRole, detectorRole, ...workerLogins.map(({ login }) => login)]) {
      if (!role) continue;
      // Identifiers were validated above. No database/schema CREATE or ownership.
      await adapter.executeSql(`GRANT USAGE ON SCHEMA pgboss TO "${role}"`);
      await adapter.executeSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO "${role}"`);
      await adapter.executeSql(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO "${role}"`);
      await adapter.executeSql(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO "${role}"`);
    }
    // Restricted worker logins are pre-provisioned by operators. This source
    // runs only in the deployment migrator, never at worker startup.
    // The lists are authoritative: revoke first, so a table dropped from a
    // role's list (or a login moved to another role) loses its grant here.
    for (const { login, role } of workerLogins) {
      await adapter.executeSql(workerGrantBlock(login, role));
    }
    if (detectorRole) {
      await adapter.executeSql(`GRANT USAGE ON SCHEMA public TO "${detectorRole}"`);
      await adapter.executeSql(`GRANT USAGE ON TYPE public.spray_detection_status TO "${detectorRole}"`);
      await adapter.executeSql(
        `GRANT SELECT ON public.spray_walls, public.spray_wall_versions, public.user_boards TO "${detectorRole}"`,
      );
      await adapter.executeSql(`GRANT SELECT, UPDATE ON public.spray_wall_detections TO "${detectorRole}"`);
    }
  } finally {
    await boss.stop({ graceful: true, close: false });
  }
}
