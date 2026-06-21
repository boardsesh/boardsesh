/**
 * Nightly recommendations refresh.
 *
 *   1. Recompute `board_setter_stats` from the catalog (setter popularity prior).
 *   2. Mine PostHog `Climb Sent to Board Success` into `board_climb_send_stats`
 *      (the Boardsesh "trending" signal). Skipped gracefully without a key.
 *   3. Regenerate the public per-board cohort playlists ("Best of Kilter 10x12
 *      @ 40°"-style) that surface in the Discover scroll.
 *
 * Run locally: `node --import tsx packages/db/scripts/refresh-recommendations.ts`
 * In CI it runs on a schedule with POSTHOG_PERSONAL_API_KEY + DATABASE_URL set.
 *
 * Idempotent: setter/send stats upsert in place; cohort playlists upsert by a
 * deterministic `generated_recommendation` key and have their climbs replaced.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { users } from '../src/schema/auth/users.js';
import { playlists, playlistClimbs, playlistOwnership } from '../src/schema/app/playlists.js';
import { boardClimbSendStats } from '../src/schema/app/recommendation-stats.js';
import {
  buildRecomputeSetterStatsSql,
  buildRecommendationRefsSql,
  type BoardTarget,
  type RecommendationType,
} from '../src/queries/recommendations/index.js';
import { rowsOf } from '../src/queries/util/rows.js';
import { getSizeFullnessTiers } from '@boardsesh/board-constants/size-comparison';
import { getProductSize, getSetsForLayoutAndSize, getLayout } from '@boardsesh/board-constants/product-sizes';
import type { BoardName } from '@boardsesh/shared-schema';

const SYSTEM_USER_ID = 'system-recommendations';
const SYSTEM_USER_EMAIL = 'recommendations@boardsesh.com';
const COHORT_SIZE = 50;
const FRESH_WINDOW_DAYS = 365;

type Cohort = { boardType: BoardName; layoutId: number; sizeId: number; angle: number };

// Curated high-value cohorts (verified ids). Kilter Original + Homewall and the
// three Tension layouts cover the boards owners actually have.
const COHORTS: Cohort[] = [
  { boardType: 'kilter', layoutId: 8, sizeId: 17, angle: 40 }, // Homewall 7x10
  { boardType: 'kilter', layoutId: 8, sizeId: 21, angle: 40 }, // Homewall 10x10
  { boardType: 'kilter', layoutId: 8, sizeId: 25, angle: 40 }, // Homewall 10x12
  { boardType: 'kilter', layoutId: 8, sizeId: 25, angle: 45 },
  { boardType: 'kilter', layoutId: 1, sizeId: 10, angle: 40 }, // Original 12x12
  { boardType: 'kilter', layoutId: 1, sizeId: 7, angle: 40 }, // Original 12x14
  { boardType: 'tension', layoutId: 9, sizeId: 1, angle: 40 }, // Original Full Wall
  { boardType: 'tension', layoutId: 10, sizeId: 6, angle: 40 }, // TB2 Mirror 12x12
  { boardType: 'tension', layoutId: 11, sizeId: 6, angle: 40 }, // TB2 Spray 12x12
];

const PUBLIC_VARIANTS: ReadonlyArray<{
  type: RecommendationType;
  slug: string;
  label: string;
  color: string;
  icon: string;
}> = [
  {
    type: 'RECOMMENDED_CROWD_FAVORITES',
    slug: 'crowd-favorites',
    label: 'Crowd Favorites',
    color: '#d65a4f',
    icon: 'LocalFireDepartmentOutlined',
  },
  {
    type: 'RECOMMENDED_HIDDEN_GEMS',
    slug: 'hidden-gems',
    label: 'Hidden Gems',
    color: '#9C27B0',
    icon: 'DiamondOutlined',
  },
  { type: 'RECOMMENDED_FRESH', slug: 'fresh', label: 'Fresh', color: '#FBBF24', icon: 'EnergySavingsLeafOutlined' },
];

const BOARD_LABEL: Record<string, string> = { kilter: 'Kilter', tension: 'Tension' };

type Db = ReturnType<typeof createScriptDb>['db'];

async function ensureSystemUser(db: Db): Promise<void> {
  await db
    .insert(users)
    .values({ id: SYSTEM_USER_ID, name: 'Boardsesh', email: SYSTEM_USER_EMAIL })
    .onConflictDoNothing({ target: users.id });
}

async function recomputeSetterStats(db: Db): Promise<void> {
  console.log('[recs] recomputing setter stats…');
  await db.execute(buildRecomputeSetterStatsSql());
}

/**
 * Mine PostHog for per-climb send counts and upsert `board_climb_send_stats`.
 * board_type is resolved from `board_climbs` (the event only carries climbUuid),
 * so a climb's send count lands on the right board.
 */
async function refreshSendStats(db: Db): Promise<void> {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  // The project id is not a secret (it appears in PostHog URLs); default it so a
  // missing repo variable can't silently leave the boost stale. The API KEY is
  // the real gate — without it we intentionally skip.
  const projectId = process.env.POSTHOG_PROJECT_ID ?? '412845';
  const host = process.env.POSTHOG_HOST ?? 'https://us.posthog.com';
  if (!apiKey) {
    console.log('[recs] POSTHOG_PERSONAL_API_KEY not set — skipping send-stats refresh (sendBoost stays neutral).');
    return;
  }

  const hogql = `
    SELECT properties.climbUuid AS climb_uuid,
           countIf(timestamp > now() - INTERVAL 30 DAY) AS sends_30d,
           count(DISTINCT if(timestamp > now() - INTERVAL 30 DAY, person_id, NULL)) AS senders_30d,
           count() AS sends_90d,
           max(timestamp) AS last_sent_at
    FROM events
    WHERE event = 'Climb Sent to Board Success'
      AND timestamp > now() - INTERVAL 90 DAY
      AND properties.climbUuid IS NOT NULL
    GROUP BY climb_uuid
  `;

  console.log('[recs] querying PostHog for send stats…');
  const response = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  });
  if (!response.ok) {
    console.error(`[recs] PostHog query failed (${response.status}) — skipping send stats.`);
    return;
  }
  const payload = (await response.json()) as { results?: unknown[][] };
  const results = payload.results ?? [];
  console.log(`[recs] PostHog returned ${results.length} climbs with sends.`);

  // [climb_uuid, sends_30d, senders_30d, sends_90d, last_sent_at]
  const byUuid = new Map<string, { s30: number; u30: number; s90: number; last: string | null }>();
  for (const row of results) {
    const uuid = String(row[0]);
    if (!uuid) continue;
    byUuid.set(uuid, {
      s30: Number(row[1] ?? 0),
      u30: Number(row[2] ?? 0),
      s90: Number(row[3] ?? 0),
      last: row[4] ? String(row[4]) : null,
    });
  }

  // Resolve board_type per climb from our catalog (batched). A UUID that maps to
  // more than one board_type is ambiguous (cross-board collision) — skip it
  // rather than assign the boost to a nondeterministic board.
  const uuids = [...byUuid.keys()];
  const boardTypesByUuid = new Map<string, Set<string>>();
  for (let i = 0; i < uuids.length; i += 1000) {
    const batch = uuids.slice(i, i + 1000);
    const rows = rowsOf<{ uuid: string; board_type: string }>(
      await db.execute(sql`SELECT uuid, board_type FROM board_climbs WHERE uuid = ANY(${batch})`),
    );
    for (const row of rows) {
      const set = boardTypesByUuid.get(row.uuid) ?? new Set<string>();
      set.add(row.board_type);
      boardTypesByUuid.set(row.uuid, set);
    }
  }

  let ambiguous = 0;
  const values = [...byUuid.entries()]
    .map(([uuid, counts]) => {
      const types = boardTypesByUuid.get(uuid);
      if (!types || types.size !== 1) {
        if (types && types.size > 1) ambiguous += 1;
        return null;
      }
      return {
        boardType: [...types][0],
        climbUuid: uuid,
        sendCount30d: counts.s30,
        senderCount30d: counts.u30,
        sendCount90d: counts.s90,
        lastSentAt: counts.last,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  // Full rebuild in one transaction: delete-all then insert. This expires rows
  // that dropped out of the 90-day window (a stale boost must not linger) and
  // gives readers an atomic swap. A successful-but-empty PostHog result clears
  // the table; a failed query returned earlier without touching it.
  await db.transaction(async (tx) => {
    await tx.delete(boardClimbSendStats);
    for (let i = 0; i < values.length; i += 500) {
      await tx.insert(boardClimbSendStats).values(values.slice(i, i + 500));
    }
  });
  console.log(`[recs] rebuilt ${values.length} send-stat rows (${ambiguous} ambiguous UUIDs skipped).`);
}

function cohortTarget(cohort: Cohort): BoardTarget {
  const setIds = getSetsForLayoutAndSize(cohort.boardType, cohort.layoutId, cohort.sizeId).map((set) => set.id);
  return {
    boardType: cohort.boardType,
    layoutId: cohort.layoutId,
    sizeId: cohort.sizeId,
    angle: cohort.angle,
    setIds: setIds.length > 0 ? setIds : null,
  };
}

function cohortPlaylistName(variantLabel: string, cohort: Cohort): string {
  const sizeName = getProductSize(cohort.boardType, cohort.sizeId)?.name ?? `size ${cohort.sizeId}`;
  const layoutName = getLayout(cohort.boardType, cohort.layoutId)?.name ?? '';
  // Layout names disambiguate same-size cohorts (e.g. TB2 Mirror vs Spray).
  // Most already lead with the brand; prefix the board label when they don't.
  const base = layoutName.toLowerCase().includes(cohort.boardType)
    ? layoutName
    : `${BOARD_LABEL[cohort.boardType] ?? cohort.boardType} ${layoutName}`.trim();
  return `${variantLabel} · ${base} ${sizeName} @ ${cohort.angle}°`;
}

async function upsertCohortPlaylist(
  db: Db,
  cohort: Cohort,
  variant: (typeof PUBLIC_VARIANTS)[number],
): Promise<{ name: string; count: number; skipped: boolean }> {
  const target = cohortTarget(cohort);
  const tiers = getSizeFullnessTiers(cohort.boardType, cohort.sizeId);
  const refs = rowsOf<{ climb_uuid: string }>(
    await db.execute(
      buildRecommendationRefsSql(
        {
          type: variant.type,
          target,
          shorterSizeIds: tiers.shorterSizeIds,
          narrowerSameHeightSizeIds: tiers.narrowerSameHeightSizeIds,
          gradeBand: null,
          excludeUserId: null,
          freshWindowDays: FRESH_WINDOW_DAYS,
        },
        0,
        COHORT_SIZE,
      ),
    ),
  );

  const name = cohortPlaylistName(variant.label, cohort);

  // Never publish (or empty) a public playlist with zero climbs — a bad
  // threshold, missing stats, or a Fresh date issue must keep the previous
  // playlist intact rather than wipe it. Skip and let the job log it.
  if (refs.length === 0) {
    return { name, count: 0, skipped: true };
  }

  const key = `${cohort.boardType}:${cohort.layoutId}:${cohort.sizeId}:${cohort.angle}:${variant.slug}`;

  // Upsert the playlist and atomically swap its climbs — a crash mid-swap must
  // never leave a published playlist empty.
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(playlists)
      .values({
        uuid: randomUUID(),
        boardType: cohort.boardType,
        layoutId: cohort.layoutId,
        name,
        description: null,
        isPublic: true,
        color: variant.color,
        icon: variant.icon,
        generatedRecommendation: key,
      })
      .onConflictDoUpdate({
        target: playlists.generatedRecommendation,
        set: { name, color: variant.color, icon: variant.icon, isPublic: true, updatedAt: new Date() },
      })
      .returning({ id: playlists.id });

    const playlistId = inserted[0].id;

    await tx
      .insert(playlistOwnership)
      .values({ playlistId, userId: SYSTEM_USER_ID, role: 'owner' })
      .onConflictDoNothing();

    await tx.delete(playlistClimbs).where(eq(playlistClimbs.playlistId, playlistId));
    await tx.insert(playlistClimbs).values(
      refs.map((ref, index) => ({
        playlistId,
        climbUuid: ref.climb_uuid,
        angle: cohort.angle,
        position: index,
      })),
    );
  });

  return { name, count: refs.length, skipped: false };
}

async function generateCohortPlaylists(db: Db): Promise<void> {
  console.log('[recs] generating cohort playlists…');
  for (const cohort of COHORTS) {
    for (const variant of PUBLIC_VARIANTS) {
      const { name, count, skipped } = await upsertCohortPlaylist(db, cohort, variant);
      console.log(`[recs]   ${name} → ${skipped ? 'SKIPPED (0 climbs, kept previous)' : `${count} climbs`}`);
    }
  }
}

async function main(): Promise<void> {
  const { db, close } = createScriptDb();
  try {
    await ensureSystemUser(db);
    await recomputeSetterStats(db);
    await refreshSendStats(db);
    await generateCohortPlaylists(db);
    console.log('[recs] done.');
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('[recs] failed:', error);
    process.exit(1);
  },
);
