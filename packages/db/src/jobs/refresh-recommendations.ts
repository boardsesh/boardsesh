/**
 * Nightly recommendations refresh.
 *
 *   1. Recompute `board_setter_stats` from the catalog (setter popularity prior).
 *   2. Mine PostHog `Climb Sent to Board Success` into `board_climb_send_stats`
 *      (the Boardsesh "trending" signal). Skipped, with a warning, without a key.
 *   3. Regenerate the public per-board cohort playlists ("Best of Kilter 10x12
 *      @ 40°"-style) that surface in the Discover scroll.
 *   4. Take the weekly `board_climb_stats_history` snapshot for the boards no
 *      sync daemon snapshots.
 *
 * Callers: the CLI `packages/db/scripts/refresh-recommendations.ts` and the
 * batch worker's `refresh-recommendations` family (docs/background-workers.md).
 * Reads go through `db`; every write batch goes through `transact`; the PostHog
 * request goes through neither, so no transaction is ever held open across it.
 *
 * Idempotent: setter/send stats upsert in place; cohort playlists upsert by a
 * deterministic `generated_recommendation` key and have their climbs replaced.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getSizeFullnessTiers } from '@boardsesh/board-constants/size-comparison';
import { getProductSize, getSetsForLayoutAndSize, getLayout } from '@boardsesh/board-constants/product-sizes';
import type { BoardName } from '@boardsesh/shared-schema';
import { playlists, playlistClimbs, playlistOwnership } from '../schema/app/playlists';
import { boardClimbs } from '../schema/boards/unified';
import { boardClimbSendStats } from '../schema/app/recommendation-stats';
import {
  buildRecomputeSetterStatsSql,
  buildRecommendationRefsSql,
  type BoardTarget,
  type RecommendationType,
} from '../queries/recommendations';
import { rowsOf } from '../queries/util/rows';
import { snapshotClimbStatsHistoryIfDue } from '../queries/climb-stats';
import { ensureSystemUser } from './system-user';
import { defaultTransact, type JobDatabase, type JobLogger, type JobRunOptions, type JobTransact } from './types';

const SYSTEM_USER_ID = 'system-recommendations';
const SYSTEM_USER_EMAIL = 'recommendations@boardsesh.com';
const COHORT_SIZE = 50;
const FRESH_WINDOW_DAYS = 365;
/** A hung PostHog query must not eat the job's lease. */
const POSTHOG_TIMEOUT_MS = 60_000;

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

// Weekly board_climb_stats_history catch-all for boards the sync daemons don't
// snapshot: MoonBoard (no periodic sync daemon at all — it froze with no writer
// since March), Woods (a code-driven board with no upstream API to sync from —
// its catalog arrives through the one-off importer) and Touchstone (an Aurora
// board with no linked user credential, so the aurora daemon's shared sync —
// which the snapshot rides — never runs for it). Each call is gated by the same
// 7-day per-board watermark, so a board the daemons already snapshotted this
// week is a no-op here.
const HISTORY_CATCHUP_BOARDS = ['moonboard', 'woods', 'touchstone'];

/** PostHog project access. The project ID and host are not secrets; the key is. */
export type PosthogQueryConfig = { apiKey: string; projectId: string; host: string };

export const POSTHOG_DEFAULT_PROJECT_ID = '412845';
export const POSTHOG_DEFAULT_HOST = 'https://us.posthog.com';

/**
 * Resolve the PostHog config from an environment. Undefined without a key: the
 * key is the real gate. The project ID is defaulted so a missing variable can't
 * silently leave the boost stale.
 */
export function posthogConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): PosthogQueryConfig | undefined {
  const apiKey = environment.POSTHOG_PERSONAL_API_KEY;
  if (!apiKey) return undefined;
  return {
    apiKey,
    projectId: environment.POSTHOG_PROJECT_ID || POSTHOG_DEFAULT_PROJECT_ID,
    host: environment.POSTHOG_HOST || POSTHOG_DEFAULT_HOST,
  };
}

export type RefreshRecommendationsOptions = JobRunOptions & {
  /** Omit to skip the send-stats refresh (logged as a warning). */
  posthog?: PosthogQueryConfig;
};

export type SendStatsOutcome =
  | { status: 'skipped'; reason: 'no-api-key' | 'query-failed' }
  | { status: 'rebuilt'; rows: number; ambiguous: number };

export type RefreshRecommendationsResult = {
  sendStats: SendStatsOutcome;
  playlists: Array<{ name: string; count: number; skipped: boolean }>;
  history: Array<{ board: string; written: number; skipped: boolean }>;
};

const SEND_STATS_HOGQL = `
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

/**
 * Mine PostHog for per-climb send counts and rebuild `board_climb_send_stats`.
 * board_type is resolved from `board_climbs` (the event only carries climbUuid),
 * so a climb's send count lands on the right board.
 */
async function refreshSendStats(
  db: JobDatabase,
  transact: JobTransact,
  signal: AbortSignal,
  log: JobLogger,
  posthog: PosthogQueryConfig | undefined,
): Promise<SendStatsOutcome> {
  if (!posthog) {
    // This silently skipped on EVERY scheduled run for months: the key was empty
    // in the environment the job ran under, and a green run hid it. Warn so the
    // degradation is impossible to miss; setting the key is the actual fix.
    log.warn(
      'POSTHOG_PERSONAL_API_KEY is not set — board_climb_send_stats was NOT refreshed and the recommendation send-boost stays neutral. Set POSTHOG_PERSONAL_API_KEY to enable it.',
    );
    return { status: 'skipped', reason: 'no-api-key' };
  }

  log.info('[recs] querying PostHog for send stats…');
  const response = await fetch(`${posthog.host}/api/projects/${posthog.projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${posthog.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: SEND_STATS_HOGQL } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(POSTHOG_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    log.warn(`[recs] PostHog query failed (${response.status}) — skipping send stats.`);
    return { status: 'skipped', reason: 'query-failed' };
  }
  const payload = (await response.json()) as { results?: unknown[][] };
  const results = payload.results ?? [];
  log.info(`[recs] PostHog returned ${results.length} climbs with sends.`);

  // [climb_uuid, sends_30d, senders_30d, sends_90d, last_sent_at]
  const byUuid = new Map<string, { s30: number; u30: number; s90: number; last: string | null }>();
  for (const row of results) {
    const uuid = String(row[0]);
    if (!uuid) continue;
    const [, sends30d, senders30d, sends90d, lastSentAt] = row;
    byUuid.set(uuid, {
      s30: Number(sends30d ?? 0),
      u30: Number(senders30d ?? 0),
      s90: Number(sends90d ?? 0),
      // HogQL returns the timestamp as an ISO string.
      last: typeof lastSentAt === 'string' && lastSentAt ? lastSentAt : null,
    });
  }

  // Resolve board_type per climb from our catalog (batched). A UUID that maps to
  // more than one board_type is ambiguous (cross-board collision) — skip it
  // rather than assign the boost to a nondeterministic board.
  const uuids = [...byUuid.keys()];
  const boardTypesByUuid = new Map<string, Set<string>>();
  for (let start = 0; start < uuids.length; start += 1000) {
    signal.throwIfAborted();
    const batch = uuids.slice(start, start + 1000);
    // A drizzle builder, not raw SQL: `= ANY(${batch})` expands the array into
    // a row constructor and fails for any batch of two or more UUIDs.
    const rows = await db
      .select({ uuid: boardClimbs.uuid, boardType: boardClimbs.boardType })
      .from(boardClimbs)
      .where(inArray(boardClimbs.uuid, batch));
    for (const row of rows) {
      const boardTypes = boardTypesByUuid.get(row.uuid) ?? new Set<string>();
      boardTypes.add(row.boardType);
      boardTypesByUuid.set(row.uuid, boardTypes);
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
  await transact(async (transaction) => {
    await transaction.delete(boardClimbSendStats);
    for (let start = 0; start < values.length; start += 500) {
      await transaction.insert(boardClimbSendStats).values(values.slice(start, start + 500));
    }
  });
  log.info(`[recs] rebuilt ${values.length} send-stat rows (${ambiguous} ambiguous UUIDs skipped).`);
  return { status: 'rebuilt', rows: values.length, ambiguous };
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
  db: JobDatabase,
  transact: JobTransact,
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
  await transact(async (transaction) => {
    const inserted = await transaction
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

    await transaction
      .insert(playlistOwnership)
      .values({ playlistId, userId: SYSTEM_USER_ID, role: 'owner' })
      .onConflictDoNothing();

    await transaction.delete(playlistClimbs).where(eq(playlistClimbs.playlistId, playlistId));
    await transaction.insert(playlistClimbs).values(
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

export async function runRefreshRecommendations(
  options: RefreshRecommendationsOptions,
): Promise<RefreshRecommendationsResult> {
  const { db, signal, log, posthog } = options;
  const transact = options.transact ?? defaultTransact(db);

  signal.throwIfAborted();
  await transact((transaction) =>
    ensureSystemUser(transaction, { id: SYSTEM_USER_ID, name: 'Boardsesh', email: SYSTEM_USER_EMAIL }),
  );

  log.info('[recs] recomputing setter stats…');
  await transact(async (transaction) => {
    await transaction.execute(buildRecomputeSetterStatsSql());
  });

  signal.throwIfAborted();
  const sendStats = await refreshSendStats(db, transact, signal, log, posthog);

  log.info('[recs] generating cohort playlists…');
  const playlistResults: RefreshRecommendationsResult['playlists'] = [];
  for (const cohort of COHORTS) {
    for (const variant of PUBLIC_VARIANTS) {
      signal.throwIfAborted();
      const result = await upsertCohortPlaylist(db, transact, cohort, variant);
      playlistResults.push(result);
      log.info(
        `[recs]   ${result.name} → ${result.skipped ? 'SKIPPED (0 climbs, kept previous)' : `${result.count} climbs`}`,
      );
    }
  }

  log.info('[recs] weekly climb-stats history snapshot (catch-all boards)…');
  const history: RefreshRecommendationsResult['history'] = [];
  for (const board of HISTORY_CATCHUP_BOARDS) {
    signal.throwIfAborted();
    // The watermark read, the INSERT … SELECT and the watermark write commit
    // together, so a lost attempt never leaves a snapshot without its watermark.
    const { written, skipped } = await transact((transaction) =>
      snapshotClimbStatsHistoryIfDue(transaction, board, (message) => log.info(message)),
    );
    history.push({ board, written, skipped });
    log.info(`[recs]   history ${board} → ${skipped ? 'not due (skipped)' : `${written} rows`}`);
  }
  log.info('[recs] done.');
  return { sendStats, playlists: playlistResults, history };
}
