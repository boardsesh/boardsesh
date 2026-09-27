process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@boardsesh/crypto';
import { BACKGROUND_JOB_QUEUES, type BackgroundWorkerRole } from '@boardsesh/db/background-jobs';
import type { DbInstance } from '@boardsesh/db/client';
import { auroraCredentials, backgroundJobRuns } from '@boardsesh/db/schema';
import { assertWorkerPrivileges } from '../job-queue-client';
import {
  enqueueBackgroundJob,
  executeBackgroundJob,
  handlerForRole,
  type BackgroundJobPayload,
} from '../../workers/jobs';
import { logger } from '../../utils/logger';
import type { BackgroundJobContext } from '../../workers/families';
import type { ProviderSyncAdapter } from '../../workers/families/provider-sync-batch';
import {
  ensureBackgroundJobSchema,
  fullSyncPage,
  insertLinkedKilterAccount,
  insertLinkedTensionAccount,
  kilterUserSyncBody,
  removeFixtures,
} from '../../workers/families/__tests__/provider-sync-fixtures';

/**
 * The proof that WORKER_ROLE_DATA_GRANTS['routine-provider'] and
 * ['maintenance-delivery'] are enough: every family those roles serve runs end
 * to end as a NOLOGIN role that holds only what the migrator granted it, with
 * the providers' HTTP replaced by small fixtures. A missing grant fails the run
 * or leaves a `permission denied` in the log, and both are checked.
 *
 * Two schemas:
 *
 * - the backend test schema (every CI run): the routine cycle for both
 *   providers, the Aurora shared catalog, the history snapshot, setter
 *   notifications and the stats self-heal. It has no PostGIS and no Kilter
 *   catalog tables, so gyms and the Kilter catalog cannot run there;
 * - a fully migrated database (the dev DB image), when
 *   `ROUTINE_GRANTS_DATABASE_URL` names one: all of the above plus gym
 *   locations (Aurora pins and the wall crawl, MoonBoard markers) and the whole
 *   Kilter catalog job. Run it by hand before changing either grant list:
 *
 *     ROUTINE_GRANTS_DATABASE_URL=postgresql://postgres:…@localhost:5440/main \
 *       vp test run --project backend packages/backend/src/services/__tests__/job-queue-roles-routine.test.ts
 */

// Keycloak is the one Kilter call no fixture can stand in for: the refresh
// grant and the JWKS check. Everything behind them runs as the restricted role.
vi.mock('../../../../kilter-sync/src/api/keycloak.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    refreshAccessToken: async () => ({ access_token: 'kilter-access', expires_in: 300, token_type: 'Bearer' }),
    verifyKeycloakToken: async () => ({ sub: 'psync-kilter-sub', preferredUsername: 'kilter-climber' }),
  };
});

// The routine cycle claims only this file's accounts, whatever else the
// database holds (the dev DB has its own linked accounts).
vi.mock('../../workers/families/provider-sync-batch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workers/families/provider-sync-batch')>();
  const { and: andSql, like: likeSql } = await import('drizzle-orm');
  const { auroraCredentials: credentials } = await import('@boardsesh/db/schema');
  return {
    ...actual,
    loadProviderSyncAdapter: async (context: BackgroundJobContext, provider: 'aurora' | 'kilter') => {
      const real = await actual.loadProviderSyncAdapter(context, provider);
      return {
        ...real,
        candidateFilter: andSql(real.candidateFilter, likeSql(credentials.userId, 'psync-rgrant-%')),
      } satisfies ProviderSyncAdapter;
    },
  };
});

const AURORA_USER = 'psync-rgrant-aurora';
const AURORA_CLIMB = 'psync-climb-rgrant';
const KILTER_USER = 'psync-rgrant-kilter';
const KILTER_CLIMB = 'psync-kclimb-rgrant';
// Outside the routine cycle's filter: a donor is borrowed, never synced here.
const DONOR_USER = 'psync-donor-rgrant';
const FOLLOWER_USER = 'psync-rgrant-follower';
const HEAL_USER = 'psync-rgrant-healer';
const SHARED_BOARD = 'soill';
const SHARED_CLIMB = 'psync-shared-climb';
const HEAL_CLIMB = 'psync-heal-climb';
const SETTER = 'psync-rgrant-setter';
const CATALOG_ID = 990_001;
const KILTER_PRODUCT = 'Psync Kilter Product';
const KILTER_PLU = 'psync-plu';
const KILTER_CATALOG_CLIMB = 'PSYNCKCATALOG0000000000000000001';
const KILTER_HOLES = [990_101, 990_102, 990_103];
const KILTER_PLACEMENTS = [990_201, 990_202, 990_203];
const MOONBOARD_GYM = 'Psync MoonBoard Gym';
const AURORA_GYM_PIN = 990_301;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** One page of Aurora's shared `/sync`: a tiny catalog touching every shared table. */
function sharedCatalogPage() {
  const at = '2026-09-01 00:00:00';
  return {
    products: [
      { id: CATALOG_ID, name: 'Psync', is_listed: true, password: null, min_count_in_frame: 2, max_count_in_frame: 35 },
    ],
    sets: [{ id: CATALOG_ID, name: 'Psync set', hsm: 1 }],
    product_sizes: [
      {
        id: CATALOG_ID,
        product_id: CATALOG_ID,
        edge_left: 0,
        edge_right: 100,
        edge_bottom: 0,
        edge_top: 150,
        name: 'Full',
        description: '',
        image_filename: null,
        position: 1,
        is_listed: true,
      },
    ],
    holes: [
      { id: CATALOG_ID, product_id: CATALOG_ID, name: 'A1', x: 10, y: 10, mirrored_hole_id: null, mirror_group: 0 },
    ],
    layouts: [
      {
        id: CATALOG_ID,
        product_id: CATALOG_ID,
        name: 'Psync layout',
        instagram_caption: null,
        is_mirrored: false,
        is_listed: true,
        password: null,
        created_at: at,
      },
    ],
    placement_roles: [
      {
        id: CATALOG_ID,
        product_id: CATALOG_ID,
        position: 1,
        name: 'start',
        full_name: 'Start',
        led_color: '00FF00',
        screen_color: '00FF00',
      },
    ],
    leds: [{ id: CATALOG_ID, product_size_id: CATALOG_ID, hole_id: CATALOG_ID, position: 1 }],
    placements: [
      {
        id: CATALOG_ID,
        layout_id: CATALOG_ID,
        hole_id: CATALOG_ID,
        set_id: CATALOG_ID,
        default_placement_role_id: CATALOG_ID,
      },
    ],
    product_sizes_layouts_sets: [
      {
        id: CATALOG_ID,
        product_size_id: CATALOG_ID,
        layout_id: CATALOG_ID,
        set_id: CATALOG_ID,
        image_filename: 'psync.png',
        is_listed: true,
      },
    ],
    climbs: [
      {
        uuid: SHARED_CLIMB,
        layout_id: CATALOG_ID,
        setter_id: 1,
        setter_username: SETTER,
        name: 'Psync shared climb',
        description: '',
        hsm: 1,
        edge_left: 0,
        edge_right: 100,
        edge_bottom: 0,
        edge_top: 150,
        angle: 40,
        frames_count: 1,
        frames_pace: 0,
        frames: `p${CATALOG_ID}r1`,
        is_draft: false,
        is_listed: true,
        created_at: at,
      },
    ],
    climb_stats: [
      {
        climb_uuid: SHARED_CLIMB,
        angle: 40,
        display_difficulty: 20,
        benchmark_difficulty: null,
        ascensionist_count: 5,
        difficulty_average: 20,
        quality_average: 3,
        fa_username: 'psync-fa',
        fa_at: '2026-09-02 00:00:00',
      },
    ],
    beta_links: [
      {
        climb_uuid: SHARED_CLIMB,
        link: 'https://instagram.com/p/psync',
        foreign_username: 'psync',
        angle: 40,
        thumbnail: 'psync.jpg',
        is_listed: true,
        created_at: at,
      },
    ],
    attempts: [{ id: CATALOG_ID, position: 1, name: 'Flash' }],
    kits: [
      {
        serial_number: 'psync-kit',
        name: 'Kit',
        is_autoconnect: false,
        is_listed: true,
        created_at: at,
        updated_at: at,
      },
    ],
    shared_syncs: [{ table_name: 'climbs', last_synchronized_at: '2026-09-01 00:00:00.000000' }],
    _complete: true,
  };
}

/** Kilter's PowerSync reference streams: one product layout, one gym with one wall. */
function kilterReferenceBody(): string {
  const ops = [
    {
      op_id: '1',
      op: 'PUT',
      object_type: 'products',
      object_id: KILTER_PRODUCT,
      data: { id: KILTER_PRODUCT, product_name: KILTER_PRODUCT, is_listed: 1 },
    },
    {
      op_id: '2',
      op: 'PUT',
      object_type: 'product_layouts',
      object_id: KILTER_PLU,
      data: {
        product_layout_uuid: KILTER_PLU,
        product_name: KILTER_PRODUCT,
        is_listed: 1,
        edge_left: 0,
        edge_right: 100,
        edge_bottom: 0,
        edge_top: 150,
      },
    },
    {
      op_id: '3',
      op: 'PUT',
      object_type: 'gyms',
      object_id: 'psync-kgym',
      data: {
        id: 'psync-kgym',
        gym_uuid: 'psync-kgym',
        name: 'Psync Kilter Gym',
        latitude: -33.9,
        longitude: 151.1,
        is_listed: 1,
      },
    },
    {
      op_id: '4',
      op: 'PUT',
      object_type: 'walls',
      object_id: 'psync-kwall',
      data: {
        id: 'psync-kwall',
        wall_uuid: 'psync-kwall',
        gym_uuid: 'psync-kgym',
        name: 'Main wall',
        product_name: KILTER_PRODUCT,
        product_layout_uuid: KILTER_PLU,
        is_adjustable: 1,
        angle: 40,
        serial_number: 'PSYNCSERIAL',
        is_listed: 1,
      },
    },
  ];
  return [JSON.stringify({ data: { bucket: 'global', data: ops } }), JSON.stringify({ checkpoint_complete: {} })]
    .map((line) => `${line}\n`)
    .join('');
}

function kilterCatalogClimb() {
  const at = '2026-09-01T00:00:00Z';
  return {
    climbUuid: KILTER_CATALOG_CLIMB,
    climbConcat: KILTER_HOLES.map((hole, index) => `h${hole}p${12 + index}`).join(''),
    name: 'Psync catalog climb',
    description: '',
    edgeLeft: 0,
    edgeRight: 100,
    edgeBottom: 0,
    edgeTop: 150,
    frameCount: 1,
    framesPace: 0,
    userUuid: null,
    username: SETTER,
    productName: KILTER_PRODUCT,
    productLayoutUuid: KILTER_PLU,
    allowMatch: false,
    isDraft: false,
    isListed: true,
    isDeleted: false,
    accumulatedHoldSetValue: null,
    origin: null,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Every provider request the five families make, answered from fixtures.
 * `gyms` switches the location fixtures on: the test schema has no PostGIS, so
 * there the pin list is empty and MoonBoard is not run.
 */
function stubProviders(options: { gyms: boolean }) {
  const moonboardLoginForm = `<form id="frmLogin">
    <input name="__RequestVerificationToken" value="csrf-token">
    <input name="form_key" value="form-key">
  </form>`;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const { pathname } = new URL(url);
    const body =
      typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '';
    // Aurora
    if (pathname === '/sessions') {
      return json({ session: { token: 'aurora-session-token', user_id: 4242 } });
    }
    if (pathname === '/sync' && url.includes('powersync') === false && !url.includes('kilter')) {
      // Shared sync posts the catalog tables' cursors; a user sync posts user tables.
      return json(body.includes('products=') ? sharedCatalogPage() : fullSyncPage(AURORA_CLIMB));
    }
    if (pathname === '/pins') {
      return json({
        gyms: options.gyms
          ? [
              {
                id: AURORA_GYM_PIN,
                username: 'psync-gym',
                name: 'Psync Aurora Gym',
                latitude: -33.85,
                longitude: 151.2,
              },
            ]
          : [],
      });
    }
    if (pathname === `/users/${AURORA_GYM_PIN}`) {
      return json({ users: [{ id: AURORA_GYM_PIN, username: 'psync-gym', walls: [] }] });
    }
    // Kilter PowerSync: the reference streams for the catalog, the user stream otherwise.
    if (pathname.endsWith('/sync/stream')) {
      const ndjson = body.includes('"global"') ? kilterReferenceBody() : kilterUserSyncBody(KILTER_CLIMB);
      return new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    // Kilter REST catalog
    if (pathname === '/api/climbs/delteduuids') return json([]);
    if (pathname === `/api/climbs/all/${KILTER_PLU}`) return json([kilterCatalogClimb()]);
    if (pathname === `/api/climb-stat/all/${KILTER_PLU}`) {
      return json([
        {
          climbUuid: KILTER_CATALOG_CLIMB,
          angle: 40,
          ascentCount: 3,
          currentDifficultyId: 20,
          difficultyAverage: 20,
          qualityAverage: 3,
          faUsername: 'psync-fa',
          faAt: '2026-09-02T00:00:00Z',
        },
      ]);
    }
    // MoonBoard
    if (pathname.toLowerCase() === '/account/login' && (init?.method ?? 'GET') === 'GET') {
      return new Response(moonboardLoginForm, { status: 200 });
    }
    if (pathname === '/Account/login') return new Response(null, { status: 302, headers: { location: '/account' } });
    if (pathname === '/account') return new Response('<main>Account</main>', { status: 200 });
    if (pathname === '/MoonBoard/GetMapMarkers') {
      return json([{ Name: MOONBOARD_GYM, Latitude: -33.87, Longitude: 151.21, LatLng: [-33.87, 151.21] }]);
    }
    throw new Error(`Unexpected request in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type Proof = { full: boolean; ownerUrl: string };

async function proveRoutineGrants({ full, ownerUrl }: Proof) {
  const suffix = randomUUID().replaceAll('-', '');
  const routineRole = `rgrant_rp_${suffix}`;
  const maintenanceRole = `rgrant_md_${suffix}`;
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const ownerClient = postgres(ownerUrl, { max: 2, onnotice: () => {} });
  const database = drizzle(ownerClient) as unknown as DbInstance;
  const ownerBoss = new PgBoss({
    connectionString: ownerUrl,
    max: 1,
    migrate: false,
    supervise: false,
    schedule: false,
  });
  ownerBoss.on('error', () => {});
  const restricted = (role: string) => {
    const url = new URL(ownerUrl);
    url.searchParams.set('options', `-c role=${role}`);
    const client = postgres(url.toString(), { max: 2, onnotice: () => {} });
    const boss = new PgBoss({
      connectionString: url.toString(),
      max: 1,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    boss.on('error', () => {});
    return { client, database: drizzle(client) as unknown as DbInstance, boss };
  };
  const routine = restricted(routineRole);
  const maintenance = restricted(maintenanceRole);

  // Everything the families log, so a swallowed `permission denied` cannot hide.
  const logged: string[] = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation(((message: unknown, meta?: unknown) => {
      logged.push(`${String(message)} ${JSON.stringify(meta ?? {})}`);
      return logger;
    }) as never);
  }

  const cleanup = async () => {
    await removeFixtures(
      database,
      [AURORA_USER, KILTER_USER, DONOR_USER, FOLLOWER_USER, HEAL_USER],
      [AURORA_CLIMB, KILTER_CLIMB, HEAL_CLIMB],
    );
    await database.execute(sql`DELETE FROM notifications WHERE recipient_id = ${FOLLOWER_USER}`);
    await database.execute(sql`DELETE FROM setter_follows WHERE follower_id = ${FOLLOWER_USER}`);
    await database.execute(sql`DELETE FROM users WHERE id = ${FOLLOWER_USER}`);
    for (const table of ['board_climb_stats_history', 'board_beta_links', 'board_climb_holds', 'board_climb_stats']) {
      await database.execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE upper(climb_uuid) IN (upper(${SHARED_CLIMB}), ${KILTER_CATALOG_CLIMB})`,
      );
    }
    await database.execute(
      sql`DELETE FROM board_climbs WHERE upper(uuid) IN (upper(${SHARED_CLIMB}), ${KILTER_CATALOG_CLIMB})`,
    );
    for (const table of [
      'board_product_sizes_layouts_sets',
      'board_placements',
      'board_leds',
      'board_placement_roles',
      'board_layouts',
      'board_holes',
      'board_product_sizes',
      'board_sets',
      'board_attempts',
      'board_products',
    ]) {
      await database.execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE board_type = ${SHARED_BOARD} AND id = ${CATALOG_ID}`,
      );
    }
    await database.execute(
      sql`DELETE FROM board_kits WHERE board_type = ${SHARED_BOARD} AND serial_number = 'psync-kit'`,
    );
    await database.execute(sql`DELETE FROM board_shared_syncs WHERE board_type = ${SHARED_BOARD}`);
    if (full) {
      await database.execute(
        sql`DELETE FROM board_climb_aliases WHERE upper(canonical_uuid) = ${KILTER_CATALOG_CLIMB}`,
      );
      await database.execute(
        sql`DELETE FROM board_climb_ingest_skips WHERE upper(climb_uuid) = ${KILTER_CATALOG_CLIMB}`,
      );
      await database.execute(sql`DELETE FROM board_layout_aliases WHERE layout_uuid = ${KILTER_PLU}`);
      // The catalog's cooldown slot, so a rerun within the hour runs the catalog again.
      await database.execute(
        sql`DELETE FROM board_shared_syncs WHERE board_type = 'kilter' AND table_name = '__local_catalog_sync__'`,
      );
      await database.execute(
        sql`DELETE FROM board_placements WHERE board_type = 'kilter' AND layout_id = ${CATALOG_ID}`,
      );
      await database.execute(sql`DELETE FROM board_layouts WHERE board_type = 'kilter' AND id = ${CATALOG_ID}`);
      await database.execute(sql`DELETE FROM board_holes WHERE board_type = 'kilter' AND product_id = ${CATALOG_ID}`);
      await database.execute(sql`DELETE FROM board_products WHERE board_type = 'kilter' AND id = ${CATALOG_ID}`);
    }
  };

  const runAs = async (
    role: BackgroundWorkerRole,
    worker: { database: DbInstance; boss: PgBoss },
    family: string,
    payload: object,
  ) => {
    const queue = BACKGROUND_JOB_QUEUES[role];
    const { runId } = await enqueueBackgroundJob(database, ownerBoss, { family, payload });
    const [job] = await worker.boss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
    expect(job?.id).toBe(runId);
    const result = await executeBackgroundJob(
      worker.database,
      worker.boss,
      job,
      handlerForRole(role),
      new AbortController().signal,
    );
    const [run] = await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId));
    expect({ family, result, errorCode: run.errorCode }).toEqual({ family, result: 'succeeded', errorCode: null });
  };

  const count = async (query: ReturnType<typeof sql>) =>
    Number(((await database.execute(query)) as unknown as Array<{ count: number }>)[0].count);

  try {
    await owner.unsafe(`CREATE ROLE "${routineRole}" NOLOGIN`);
    await owner.unsafe(`CREATE ROLE "${maintenanceRole}" NOLOGIN`);
    await ensureBackgroundJobSchema(owner, [
      `routine-provider=${routineRole}`,
      `maintenance-delivery=${maintenanceRole}`,
    ]);
    await ownerBoss.start();
    await routine.boss.start();
    await maintenance.boss.start();
    for (const queue of [BACKGROUND_JOB_QUEUES['routine-provider'], BACKGROUND_JOB_QUEUES['maintenance-delivery']]) {
      await ownerBoss.deleteAllJobs(queue);
    }
    await cleanup();
    await assertWorkerPrivileges(routine.boss.getDb());
    await assertWorkerPrivileges(maintenance.boss.getDb());

    // Fixtures, written as the owner.
    await insertLinkedTensionAccount(database, AURORA_USER, AURORA_CLIMB);
    await insertLinkedKilterAccount(database, KILTER_USER, KILTER_CLIMB);
    await database.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${DONOR_USER}, ${DONOR_USER + '@test.com'}, 'Donor', now(), now()),
             (${FOLLOWER_USER}, ${FOLLOWER_USER + '@test.com'}, 'Follower', now(), now()),
             (${HEAL_USER}, ${HEAL_USER + '@test.com'}, 'Healer', now(), now())
      ON CONFLICT (id) DO NOTHING`);
    await database.insert(auroraCredentials).values({
      userId: DONOR_USER,
      boardType: SHARED_BOARD,
      encryptedUsername: encrypt('donor'),
      encryptedPassword: encrypt('hunter2'),
      auroraUserId: 4243,
      auroraToken: encrypt('donor-token'),
      syncStatus: 'active',
      lastSyncAt: new Date(),
    });
    await database.execute(
      sql`INSERT INTO setter_follows (follower_id, setter_username) VALUES (${FOLLOWER_USER}, ${SETTER})`,
    );
    // A send whose stats row a dropped recompute left behind.
    await database.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, is_listed)
      VALUES (${HEAL_CLIMB}, 'kilter', 1, 'setter', 'Heal', 'p1r1', true)`);
    await database.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, upstream_ascensionist_count, ascensionist_count,
                                     boardsesh_ascensionist_count, updated_at)
      VALUES ('kilter', ${HEAL_CLIMB}, 40, 0, 0, 0, now() - interval '30 days')`);
    await database.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, origin, attempt_count,
                                   climbed_at, created_at, updated_at)
      VALUES (gen_random_uuid()::text, ${HEAL_USER}, 'kilter', ${HEAL_CLIMB}, 40, 'send'::tick_status,
              'native'::tick_origin, 1, '2026-01-01 00:00:00', now(), now())`);
    if (full) {
      await database.execute(sql`
        INSERT INTO board_products (board_type, id, name, is_listed) VALUES ('kilter', ${CATALOG_ID}, ${KILTER_PRODUCT}, true)`);
      await database.execute(sql`
        INSERT INTO board_layouts (board_type, id, product_id, name, is_listed, is_mirrored)
        VALUES ('kilter', ${CATALOG_ID}, ${CATALOG_ID}, 'Psync Kilter Layout', true, false)`);
      for (const [index, hole] of KILTER_HOLES.entries()) {
        await database.execute(sql`
          INSERT INTO board_holes (board_type, id, product_id, name, x, y, mirror_group)
          VALUES ('kilter', ${hole}, ${CATALOG_ID}, ${`P${index}`}, ${index * 8}, 8, 0)`);
        await database.execute(sql`
          INSERT INTO board_placements (board_type, id, layout_id, hole_id, set_id)
          VALUES ('kilter', ${KILTER_PLACEMENTS[index]}, ${CATALOG_ID}, ${hole}, 1)`);
      }
    }

    stubProviders({ gyms: full });
    vi.stubEnv('KILTER_OAUTH_CLIENT_ID', 'grant-test-client');
    vi.stubEnv('MOONBOARD_USERNAME', full ? 'operator@example.com' : '');
    vi.stubEnv('MOONBOARD_PASSWORD', full ? 'secret' : '');

    // A credential linked before control rows existed: the routine cycle
    // creates its control row (without a new generation) before syncing.
    await database.execute(sql`DELETE FROM provider_sync_controls WHERE user_id = ${AURORA_USER}`);

    // 1. The routine cycle, both providers: a whole user sync each.
    await runAs('routine-provider', routine, 'provider-routine-cycle', { provider: 'aurora' });
    await runAs('routine-provider', routine, 'provider-routine-cycle', { provider: 'kilter' });
    for (const userId of [AURORA_USER, KILTER_USER]) {
      const [credential] = await database.select().from(auroraCredentials).where(eq(auroraCredentials.userId, userId));
      expect({ userId, status: credential.syncStatus, error: credential.lastSyncError }).toEqual({
        userId,
        status: 'active',
        error: null,
      });
    }
    expect(await count(sql`SELECT count(*)::int AS count FROM boardsesh_ticks WHERE user_id = ${AURORA_USER}`)).toBe(2);
    expect(
      await count(
        sql`SELECT count(*)::int AS count FROM provider_sync_controls WHERE user_id = ${AURORA_USER} AND linked`,
      ),
    ).toBe(1);

    // 2. The Aurora shared sync: every catalog table, the history snapshot, the
    //    setter notification, and (migrated schema) the pins and a crawl slice.
    await runAs('routine-provider', routine, 'aurora-shared-sync', { board: SHARED_BOARD });
    expect(logged.some((line) => line.includes('shared sync finished'))).toBe(true);
    expect(
      await count(
        sql`SELECT count(*)::int AS count FROM board_placements WHERE board_type = ${SHARED_BOARD} AND id = ${CATALOG_ID}`,
      ),
    ).toBe(1);
    expect(
      await count(sql`SELECT count(*)::int AS count FROM board_climb_stats_history WHERE climb_uuid = ${SHARED_CLIMB}`),
    ).toBe(1);
    expect(
      await count(sql`SELECT count(*)::int AS count FROM notifications WHERE recipient_id = ${FOLLOWER_USER}`),
    ).toBe(1);
    const [cooldown] = (await database.execute(sql`
      SELECT last_synchronized_at AS cursor FROM board_shared_syncs
       WHERE board_type = ${SHARED_BOARD} AND table_name = '__local_shared_sync__'`)) as unknown as Array<{
      cursor: string;
    }>;
    expect(cooldown.cursor).toContain('#finished:');

    if (full) {
      expect(
        await count(
          sql`SELECT count(*)::int AS count FROM location_sync_gym_sources WHERE source_key = ${`${SHARED_BOARD}:${AURORA_GYM_PIN}`}`,
        ),
      ).toBe(1);

      // 3. The Kilter catalog: climbs, holds, aliases, stats, layout aliases,
      //    locations, the weekly repair and snapshot.
      await runAs('routine-provider', routine, 'kilter-catalog-sync', {});
      expect(logged.some((line) => line.includes('catalog sync finished'))).toBe(true);
      expect(
        await count(sql`SELECT count(*)::int AS count FROM board_layout_aliases WHERE layout_uuid = ${KILTER_PLU}`),
      ).toBe(1);
      const [catalogCursor] = (await database.execute(sql`
        SELECT last_synchronized_at AS cursor FROM board_shared_syncs
         WHERE board_type = 'kilter' AND table_name = '__local_catalog_sync__'`)) as unknown as Array<{
        cursor: string;
      }>;
      expect(catalogCursor.cursor).toContain('#finished:');
      // The catalog climb landed (or was recorded as un-ingestable): the write path ran.
      expect(
        await count(sql`SELECT (
            (SELECT count(*) FROM board_climbs WHERE upper(uuid) = ${KILTER_CATALOG_CLIMB})
          + (SELECT count(*) FROM board_climb_ingest_skips WHERE upper(climb_uuid) = ${KILTER_CATALOG_CLIMB})
        )::int AS count`),
      ).toBe(1);

      // 4. MoonBoard's gyms.
      await runAs('routine-provider', routine, 'moonboard-locations-sync', {});
      expect(logged.some((line) => line.includes('moonboard locations finished'))).toBe(true);
      expect(await count(sql`SELECT count(*)::int AS count FROM gyms WHERE name = ${MOONBOARD_GYM}`)).toBe(1);
    }

    // 5. The stats self-heal, as the maintenance login.
    await runAs('maintenance-delivery', maintenance, 'climb-stats-self-heal', {});
    expect(
      await count(sql`SELECT boardsesh_ascensionist_count::int AS count FROM board_climb_stats
                       WHERE board_type = 'kilter' AND climb_uuid = ${HEAL_CLIMB} AND angle = 40`),
    ).toBe(1);

    // Nothing was refused and swallowed on the way.
    expect(logged.filter((line) => /permission denied|"sqlState":"42501"/i.test(line))).toEqual([]);

    // And the grants stop where they should.
    const routineDb = routine.boss.getDb();
    await expect(routineDb.executeSql('SELECT email FROM public.users LIMIT 1')).rejects.toThrow('permission denied');
    await expect(routineDb.executeSql('DELETE FROM public.gyms WHERE false')).rejects.toThrow('permission denied');
    await expect(routineDb.executeSql('SELECT body FROM public.comments LIMIT 1')).rejects.toThrow('permission denied');
    const maintenanceDb = maintenance.boss.getDb();
    await expect(maintenanceDb.executeSql('SELECT comment FROM public.boardsesh_ticks LIMIT 1')).rejects.toThrow(
      'permission denied',
    );
    await expect(maintenanceDb.executeSql('UPDATE public.board_climbs SET name = name WHERE false')).rejects.toThrow(
      'permission denied',
    );
    await expect(maintenanceDb.executeSql('SELECT 1 FROM public.aurora_credentials LIMIT 1')).rejects.toThrow(
      'permission denied',
    );
  } finally {
    await routine.boss.stop({ graceful: true, close: true });
    await maintenance.boss.stop({ graceful: true, close: true });
    await ownerBoss.stop({ graceful: true, close: true });
    await routine.client.end();
    await maintenance.client.end();
    await cleanup().catch(() => {});
    await ownerClient.end();
    for (const role of [routineRole, maintenanceRole]) {
      await owner.unsafe(`DROP OWNED BY "${role}"`).catch(() => {});
      await owner.unsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    }
    await owner.end();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('routine-provider and maintenance-delivery worker grants', () => {
  it('run the routine cycle, the Aurora shared catalog and the self-heal as the restricted roles (test schema)', async () => {
    await proveRoutineGrants({ full: false, ownerUrl: process.env.DATABASE_URL! });
  }, 120_000);

  it.skipIf(!process.env.ROUTINE_GRANTS_DATABASE_URL)(
    'run every routine family, locations and the Kilter catalog included (migrated schema)',
    async () => {
      await proveRoutineGrants({ full: true, ownerUrl: process.env.ROUTINE_GRANTS_DATABASE_URL! });
    },
    300_000,
  );
});
