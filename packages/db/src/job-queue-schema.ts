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

type TablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/** One GRANT on a `public` table, optionally limited to some columns. */
export type WorkerTableGrant = {
  table: string;
  privileges: readonly TablePrivilege[];
  columns?: readonly string[];
};

/**
 * Data grants per worker role, on top of the pg-boss DML and the ledger every
 * worker login gets. Each list is exactly what that role's families read and
 * write, and is proven by running every family under the restricted role in
 * packages/backend/src/services/__tests__/job-queue-roles.test.ts. Sequences
 * owned by a table the role may INSERT into get USAGE. Roles whose families
 * ship later add their lists in the PR that ships them.
 */
export const WORKER_ROLE_DATA_GRANTS: Record<BackgroundWorkerRole, readonly WorkerTableGrant[]> = {
  'interactive-import': [],
  'routine-provider': [],
  'maintenance-delivery': [],
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
    { table: 'user_boards', privileges: ['SELECT'], columns: ['id', 'gym_id'] },
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
    await boss.createQueue(SPRAY_DETECTION_DEAD_QUEUE, { partition: false });
    await boss.createQueue(SPRAY_DETECTION_QUEUE, { partition: false, ...SPRAY_DETECTION_JOB_OPTIONS });
    await boss.updateQueue(SPRAY_DETECTION_QUEUE, SPRAY_DETECTION_JOB_OPTIONS);
    await boss.createQueue(SPRAY_DETECTION_RECONCILE_QUEUE, {
      partition: false,
      policy: 'singleton',
      expireInSeconds: 120,
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
