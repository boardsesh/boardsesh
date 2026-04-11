import { z } from 'zod';
import { eq, and, or, inArray, sql } from 'drizzle-orm';
import { getPool } from '@/app/lib/db/db';
import { drizzle } from 'drizzle-orm/neon-serverless';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import {
  boardseshTicks,
  boardClimbs,
  boardClimbStats,
  playlists,
  playlistClimbs,
  playlistOwnership,
} from '@/app/lib/db/schema';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { fontGradeToDifficultyId } from '@/app/lib/board-data';
import { LAYOUTS, HOLE_PLACEMENTS } from '@/app/lib/board-constants';
import { buildInferredSessionsForUser } from './inferred-session-builder';
import { populateDenormalizedColumns } from '@boardsesh/db/queries';
import type { AuroraBoardName } from '@boardsesh/shared-schema';

const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Zod schema for the Aurora JSON export format
// ---------------------------------------------------------------------------

const auroraExportAscentSchema = z.object({
  climb: z.string(),
  angle: z.number(),
  count: z.number(),
  stars: z.number(),
  climbed_at: z.string(),
  created_at: z.string(),
  grade: z.string(),
});

const auroraExportAttemptSchema = z.object({
  climb: z.string(),
  angle: z.number(),
  count: z.number(),
  climbed_at: z.string(),
  created_at: z.string(),
});

const auroraExportCircuitSchema = z.object({
  name: z.string(),
  color: z.string(),
  created_at: z.string(),
  description: z.string().optional(),
  is_private: z.boolean().optional(),
  climbs: z.array(z.string()),
});

const auroraExportClimbSchema = z.object({
  name: z.string(),
  layout: z.string(),
  created_at: z.string(),
  is_draft: z.boolean().nullable().optional(),
  holds: z.array(z.object({ x: z.number(), y: z.number(), role: z.string() })),
  description: z.string().optional(),
});

export const auroraExportSchema = z.object({
  user: z.object({
    username: z.string(),
    email_address: z.string().optional(),
    created_at: z.string().optional(),
  }),
  ascents: z.array(auroraExportAscentSchema).default([]),
  attempts: z.array(auroraExportAttemptSchema).default([]),
  circuits: z.array(auroraExportCircuitSchema).default([]),
  climbs: z.array(auroraExportClimbSchema).default([]),
  likes: z.array(z.object({ climb: z.string(), created_at: z.string() })).default([]),
  // Fields we don't import but should accept without error
  follows: z.array(z.unknown()).optional(),
  walls: z.array(z.unknown()).optional(),
  blocks: z.array(z.unknown()).optional(),
  beta_links: z.array(z.unknown()).optional(),
  agreements: z.array(z.unknown()).optional(),
});

export type AuroraExportData = z.infer<typeof auroraExportSchema>;

type BoardType = AuroraBoardName;

// ---------------------------------------------------------------------------
// Import result types
// ---------------------------------------------------------------------------

export interface ImportCounts {
  imported: number;
  skipped: number;
  failed: number;
}

export interface ImportResult {
  ascents: ImportCounts;
  attempts: ImportCounts;
  circuits: ImportCounts;
  climbs: ImportCounts;
  unresolvedClimbs: string[];
}

// ---------------------------------------------------------------------------
// Progress event types for streaming progress reporting
// ---------------------------------------------------------------------------

export type ImportProgressEvent =
  | { type: 'progress'; step: 'climbs'; current: number; total: number }
  | { type: 'progress'; step: 'resolving'; message: string }
  | { type: 'progress'; step: 'dedup'; message: string }
  | { type: 'progress'; step: 'ascents'; current: number; total: number }
  | { type: 'progress'; step: 'attempts'; current: number; total: number }
  | { type: 'progress'; step: 'circuits'; current: number; total: number }
  | { type: 'progress'; step: 'sessions'; message: string }
  | { type: 'complete'; results: ImportResult }
  | { type: 'error'; error: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a timestamp to ISO format for consistent dedup key generation.
 * Drizzle returns timestamps as "2024-01-15 10:30:00" (no T, no Z),
 * while new Date().toISOString() produces "2024-01-15T10:30:00.000Z".
 *
 * Space-separated timestamps (from Drizzle/Aurora) have no timezone indicator
 * and represent UTC. We must explicitly treat them as UTC before parsing,
 * otherwise `new Date()` interprets them as local time.
 */
export function normalizeTimestamp(ts: string): string {
  let normalized = ts.trim();
  // If the string has no timezone indicator (T/Z/+/-), treat as UTC
  // by replacing the space separator with 'T' and appending 'Z'
  if (!normalized.includes('T') && !normalized.includes('Z')) {
    // Truncate microseconds (.000001) to milliseconds (.000) for consistency
    normalized = normalized.replace(/(\.\d{3})\d*$/, '$1');
    normalized = normalized.replace(' ', 'T') + 'Z';
  }
  return new Date(normalized).toISOString();
}

export function generateJsonImportAuroraId(
  userId: string,
  climbUuid: string,
  angle: number,
  climbedAt: string,
  type: 'ascents' | 'bids',
): string {
  const hash = createHash('sha256')
    .update(`${userId}:${climbUuid}:${angle}:${climbedAt}:${type}`)
    .digest('hex')
    .slice(0, 32);
  return `json-import-${hash}`;
}

// ---------------------------------------------------------------------------
// Climb draft import helpers
// ---------------------------------------------------------------------------

/** Map export role names to board-specific hold state codes. */
const ROLE_TO_CODE: Record<BoardType, Record<string, number>> = {
  kilter: { start: 42, middle: 43, finish: 44, foot: 45 },
  tension: { start: 1, middle: 2, finish: 3, foot: 4 },
  // Decoy, Touchstone, and Grasshopper all use the same Aurora hold-state
  // codes as Tension (1=start, 2=middle, 3=finish, 4=foot). See
  // packages/db/scripts/aurora-board-import-helpers.ts for the inverse mapping.
  decoy: { start: 1, middle: 2, finish: 3, foot: 4 },
  touchstone: { start: 1, middle: 2, finish: 3, foot: 4 },
  grasshopper: { start: 1, middle: 2, finish: 3, foot: 4 },
};

/** Resolve a layout name (e.g. "Kilter Board Original") to a layout ID. */
export function resolveLayoutName(boardType: BoardType, layoutName: string): number | null {
  const layouts = LAYOUTS[boardType];
  for (const layout of Object.values(layouts)) {
    if (layout.name === layoutName) return layout.id;
  }
  return null;
}

/**
 * Build an (x,y) → placementId lookup for all sets within a layout.
 * Caches results since multiple climbs often share the same layout.
 */
const coordinateMapCache = new Map<string, Map<string, number>>();

export function buildCoordinateMap(boardType: BoardType, layoutId: number): Map<string, number> {
  const cacheKey = `${boardType}:${layoutId}`;
  const cached = coordinateMapCache.get(cacheKey);
  if (cached) return cached;

  const coordMap = new Map<string, number>();
  const boardPlacements = HOLE_PLACEMENTS[boardType];

  for (const key of Object.keys(boardPlacements)) {
    // Keys are "layoutId-setId"
    if (!key.startsWith(`${layoutId}-`)) continue;

    for (const [placementId, , x, y] of boardPlacements[key]) {
      coordMap.set(`${x},${y}`, placementId);
    }
  }

  coordinateMapCache.set(cacheKey, coordMap);
  return coordMap;
}

/** Convert export holds to a frames string (e.g. "p1233r42p1270r42"). */
export function convertHoldsToFrames(
  holds: { x: number; y: number; role: string }[],
  coordMap: Map<string, number>,
  boardType: BoardType,
): string | null {
  const roleCodes = ROLE_TO_CODE[boardType];
  const parts: string[] = [];

  for (const hold of holds) {
    const placementId = coordMap.get(`${hold.x},${hold.y}`);
    if (placementId == null) continue;

    const roleCode = roleCodes[hold.role];
    if (roleCode == null) continue;

    parts.push(`p${placementId}r${roleCode}`);
  }

  return parts.length > 0 ? parts.join('') : null;
}

/** Compute bounding box (edge) values from hold coordinates. */
export function computeEdgesFromHolds(holds: { x: number; y: number }[]): {
  edgeLeft: number; edgeRight: number; edgeBottom: number; edgeTop: number;
} | null {
  if (holds.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const hold of holds) {
    if (hold.x < minX) minX = hold.x;
    if (hold.x > maxX) maxX = hold.x;
    if (hold.y < minY) minY = hold.y;
    if (hold.y > maxY) maxY = hold.y;
  }
  return { edgeLeft: minX, edgeRight: maxX, edgeBottom: minY, edgeTop: maxY };
}

/** Generate a deterministic UUID for an imported draft climb. */
export function generateClimbImportUuid(
  userId: string,
  boardType: string,
  layoutId: number,
  name: string,
  createdAt: string,
): string {
  const hash = createHash('sha256')
    .update(`${userId}:${boardType}:${layoutId}:${name}:${createdAt}`)
    .digest('hex')
    .slice(0, 32);
  return `json-import-climb-${hash}`;
}

// ---------------------------------------------------------------------------
// Climb name resolution
// ---------------------------------------------------------------------------

async function resolveClimbNames(
  db: NeonDatabase<Record<string, never>>,
  boardType: BoardType,
  climbNames: string[],
  userId?: string,
): Promise<Map<string, string>> {
  if (climbNames.length === 0) return new Map();

  // Track best match across all chunks: name -> { uuid, ascensionistCount, isPublic }
  const nameToMatch = new Map<string, { uuid: string; count: number; isPublic: boolean }>();

  // Batch in chunks of 500 to avoid overly large IN clauses
  const chunkSize = 500;
  for (let i = 0; i < climbNames.length; i += chunkSize) {
    const chunk = climbNames.slice(i, i + chunkSize);

    // Query public climbs with stats to pick the most popular when duplicates exist
    const publicFilter = and(
      eq(boardClimbs.boardType, boardType),
      inArray(boardClimbs.name, chunk),
      eq(boardClimbs.isListed, true),
      eq(boardClimbs.isDraft, false),
    );

    // Also match user's own drafts so ascents/circuits referencing their climbs resolve
    const userDraftFilter = userId
      ? and(
          eq(boardClimbs.boardType, boardType),
          inArray(boardClimbs.name, chunk),
          eq(boardClimbs.userId, userId),
        )
      : undefined;

    const whereClause = userDraftFilter
      ? or(publicFilter, userDraftFilter)
      : publicFilter;

    const results = await db
      .select({
        uuid: boardClimbs.uuid,
        name: boardClimbs.name,
        ascensionistCount: boardClimbStats.ascensionistCount,
        isListed: boardClimbs.isListed,
        isDraft: boardClimbs.isDraft,
      })
      .from(boardClimbs)
      .leftJoin(
        boardClimbStats,
        and(
          eq(boardClimbStats.climbUuid, boardClimbs.uuid),
          eq(boardClimbStats.boardType, boardClimbs.boardType),
        ),
      )
      .where(whereClause);

    for (const row of results) {
      if (!row.name) continue;

      const count = row.ascensionistCount ?? 0;
      const isPublic = row.isListed === true && row.isDraft === false;
      const existing = nameToMatch.get(row.name);

      // Prefer public climbs over drafts; among same type prefer higher ascensionist count
      if (!existing) {
        nameToMatch.set(row.name, { uuid: row.uuid, count, isPublic });
      } else if (isPublic && !existing.isPublic) {
        // Public always wins over draft
        nameToMatch.set(row.name, { uuid: row.uuid, count, isPublic });
      } else if (isPublic === existing.isPublic && count > existing.count) {
        // Same visibility tier: pick higher count
        nameToMatch.set(row.name, { uuid: row.uuid, count, isPublic });
      }
    }
  }

  // Convert to simple name -> uuid map
  return new Map(
    [...nameToMatch].map(([name, match]) => [name, match.uuid]),
  );
}

// ---------------------------------------------------------------------------
// Cross-source dedup: fetch existing tick keys for this user + board
// ---------------------------------------------------------------------------

async function getExistingTickKeys(
  db: NeonDatabase<Record<string, never>>,
  userId: string,
  boardType: BoardType,
): Promise<Set<string>> {
  const existing = await db
    .select({
      climbUuid: boardseshTicks.climbUuid,
      angle: boardseshTicks.angle,
      climbedAt: boardseshTicks.climbedAt,
    })
    .from(boardseshTicks)
    .where(
      and(
        eq(boardseshTicks.userId, userId),
        eq(boardseshTicks.boardType, boardType),
      ),
    );

  return new Set(
    existing.map((row) => {
      const normalized = normalizeTimestamp(row.climbedAt);
      return `${row.climbUuid}:${row.angle}:${normalized}`;
    }),
  );
}

// ---------------------------------------------------------------------------
// Batch insert helper
// ---------------------------------------------------------------------------

async function batchInsertTicks(
  db: NeonDatabase<Record<string, never>>,
  rows: (typeof boardseshTicks.$inferInsert)[],
  conflictSet: Record<string, ReturnType<typeof sql>>,
  step: 'ascents' | 'attempts',
  fallbackTotal: number,
  onProgress?: (event: ImportProgressEvent) => void,
): Promise<number> {
  if (rows.length === 0) {
    onProgress?.({ type: 'progress', step, current: fallbackTotal, total: fallbackTotal });
    return 0;
  }

  let imported = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    await db
      .insert(boardseshTicks)
      .values(batch)
      .onConflictDoUpdate({
        target: boardseshTicks.auroraId,
        set: conflictSet,
      });

    imported += batch.length;
    onProgress?.({ type: 'progress', step, current: Math.min(i + BATCH_SIZE, rows.length), total: rows.length });
  }

  return imported;
}

// ---------------------------------------------------------------------------
// Main import function
// ---------------------------------------------------------------------------

export async function importJsonExportData(
  userId: string,
  boardType: BoardType,
  data: AuroraExportData,
  onProgress?: (event: ImportProgressEvent) => void,
  options?: { skipSessionBuild?: boolean },
): Promise<ImportResult> {
  const result: ImportResult = {
    ascents: { imported: 0, skipped: 0, failed: 0 },
    attempts: { imported: 0, skipped: 0, failed: 0 },
    circuits: { imported: 0, skipped: 0, failed: 0 },
    climbs: { imported: 0, skipped: 0, failed: 0 },
    unresolvedClimbs: [],
  };

  // Capture a single "now" for all timestamps in this import
  const now = new Date().toISOString();

  const pool = getPool();
  const client = await pool.connect();

  try {
    const db = drizzle(client);

    // Step 1: Import climbs FIRST so they're available for name resolution.
    // Draft climbs are always imported (upserted) against the user's account.
    // Published (non-draft) climbs are only inserted if they don't already exist
    // in our DB -- following the shared-sync pattern where existing published
    // climbs are never overwritten.
    if (data.climbs.length > 0) {
      type ClimbRow = typeof boardClimbs.$inferInsert;

      // Split climbs into drafts and published
      const draftClimbs = data.climbs.filter((c) => c.is_draft === true);
      const publishedClimbs = data.climbs.filter((c) => c.is_draft !== true);

      // For published climbs, check which names already exist so we skip them
      const publishedNames = publishedClimbs.map((c) => c.name);
      const existingPublishedNames = new Set<string>();
      if (publishedNames.length > 0) {
        const chunkSize = 500;
        for (let i = 0; i < publishedNames.length; i += chunkSize) {
          const chunk = publishedNames.slice(i, i + chunkSize);
          const existing = await db
            .select({ name: boardClimbs.name })
            .from(boardClimbs)
            .where(
              and(
                eq(boardClimbs.boardType, boardType),
                inArray(boardClimbs.name, chunk),
                eq(boardClimbs.isDraft, false),
              ),
            );
          for (const row of existing) {
            if (row.name) existingPublishedNames.add(row.name);
          }
        }
      }

      // Build rows for draft climbs (always imported)
      const draftRows: ClimbRow[] = [];
      for (const climb of draftClimbs) {
        const layoutId = resolveLayoutName(boardType, climb.layout);
        if (layoutId == null) { result.climbs.failed++; continue; }

        const coordMap = buildCoordinateMap(boardType, layoutId);
        const frames = convertHoldsToFrames(climb.holds, coordMap, boardType);
        if (!frames) { result.climbs.failed++; continue; }

        const edges = computeEdgesFromHolds(climb.holds);

        draftRows.push({
          uuid: generateClimbImportUuid(userId, boardType, layoutId, climb.name, climb.created_at),
          boardType,
          layoutId,
          userId,
          setterId: null,
          setterUsername: data.user.username,
          name: climb.name,
          description: climb.description ?? '',
          frames,
          framesCount: 1,
          framesPace: 0,
          isDraft: true,
          isListed: false,
          edgeLeft: edges?.edgeLeft ?? null,
          edgeRight: edges?.edgeRight ?? null,
          edgeBottom: edges?.edgeBottom ?? null,
          edgeTop: edges?.edgeTop ?? null,
          angle: null,
          createdAt: climb.created_at ?? now,
          synced: false,
          syncError: null,
        });
      }

      // Build rows for published climbs that don't already exist
      const publishedRows: ClimbRow[] = [];
      for (const climb of publishedClimbs) {
        if (existingPublishedNames.has(climb.name)) {
          result.climbs.skipped++;
          continue;
        }

        const layoutId = resolveLayoutName(boardType, climb.layout);
        if (layoutId == null) { result.climbs.failed++; continue; }

        const coordMap = buildCoordinateMap(boardType, layoutId);
        const frames = convertHoldsToFrames(climb.holds, coordMap, boardType);
        if (!frames) { result.climbs.failed++; continue; }

        const edges = computeEdgesFromHolds(climb.holds);

        publishedRows.push({
          uuid: generateClimbImportUuid(userId, boardType, layoutId, climb.name, climb.created_at),
          boardType,
          layoutId,
          userId,
          setterId: null,
          setterUsername: data.user.username,
          name: climb.name,
          description: climb.description ?? '',
          frames,
          framesCount: 1,
          framesPace: 0,
          isDraft: false,
          isListed: true,
          edgeLeft: edges?.edgeLeft ?? null,
          edgeRight: edges?.edgeRight ?? null,
          edgeBottom: edges?.edgeBottom ?? null,
          edgeTop: edges?.edgeTop ?? null,
          angle: null,
          createdAt: climb.created_at ?? now,
          synced: false,
          syncError: null,
        });
      }

      const totalRows = draftRows.length + publishedRows.length;

      if (totalRows > 0) {
        await client.query('BEGIN');
        try {
          // Insert draft climbs with upsert (re-import updates them)
          for (let i = 0; i < draftRows.length; i += BATCH_SIZE) {
            const batch = draftRows.slice(i, i + BATCH_SIZE);
            await db
              .insert(boardClimbs)
              .values(batch)
              .onConflictDoUpdate({
                target: boardClimbs.uuid,
                set: {
                  name: sql`excluded.name`,
                  setterUsername: sql`excluded.setter_username`,
                  description: sql`excluded.description`,
                  frames: sql`excluded.frames`,
                  isDraft: sql`excluded.is_draft`,
                  isListed: sql`excluded.is_listed`,
                  edgeLeft: sql`excluded.edge_left`,
                  edgeRight: sql`excluded.edge_right`,
                  edgeBottom: sql`excluded.edge_bottom`,
                  edgeTop: sql`excluded.edge_top`,
                },
              });
            result.climbs.imported += batch.length;
          }

          // Insert published climbs — skip on conflict (already exist from a prior import)
          for (let i = 0; i < publishedRows.length; i += BATCH_SIZE) {
            const batch = publishedRows.slice(i, i + BATCH_SIZE);
            await db
              .insert(boardClimbs)
              .values(batch)
              .onConflictDoNothing();
            result.climbs.imported += batch.length;
          }

          // Populate denormalized required_set_ids and compatible_size_ids
          const allInsertedUuids = [
            ...draftRows.map((r) => r.uuid),
            ...publishedRows.map((r) => r.uuid),
          ];
          await populateDenormalizedColumns(db, boardType, allInsertedUuids);

          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }

      onProgress?.({ type: 'progress', step: 'climbs', current: data.climbs.length, total: data.climbs.length });
    } else {
      onProgress?.({ type: 'progress', step: 'climbs', current: 0, total: 0 });
    }

    // Step 2: Collect all unique climb names from ascents/attempts/circuits
    const allClimbNames = new Set([
      ...data.ascents.map((a) => a.climb),
      ...data.attempts.map((a) => a.climb),
      ...data.circuits.flatMap((c) => c.climbs),
    ]);

    // Step 3: Resolve climb names to UUIDs (includes user's own drafts)
    onProgress?.({ type: 'progress', step: 'resolving', message: `Resolving ${allClimbNames.size} climb names...` });
    const nameToUuid = await resolveClimbNames(db, boardType, [...allClimbNames], userId);

    // Track unresolved names
    result.unresolvedClimbs = [...allClimbNames].filter((name) => !nameToUuid.has(name));

    // Step 4: Get existing tick keys for cross-source dedup
    onProgress?.({ type: 'progress', step: 'dedup', message: 'Checking for duplicates...' });
    const existingKeys = await getExistingTickKeys(db, userId, boardType);

    // Step 5: Collect ascent rows to insert (in-memory dedup first)
    type TickRow = typeof boardseshTicks.$inferInsert;

    const ascentRows = data.ascents.reduce<TickRow[]>((rows, ascent) => {
      const climbUuid = nameToUuid.get(ascent.climb);
      if (!climbUuid) { result.ascents.failed++; return rows; }

      const climbedAt = normalizeTimestamp(ascent.climbed_at);
      const tickKey = `${climbUuid}:${ascent.angle}:${climbedAt}`;
      if (existingKeys.has(tickKey)) { result.ascents.skipped++; return rows; }

      existingKeys.add(tickKey);
      rows.push({
        uuid: randomUUID(),
        userId,
        boardType,
        climbUuid,
        angle: ascent.angle,
        isMirror: false,
        status: ascent.count === 1 ? 'flash' : 'send',
        attemptCount: ascent.count,
        // The JSON export 'stars' field is already on a 1-5 scale (user-facing),
        // unlike the Aurora API 'quality' field which is 0-3.
        quality: ascent.stars,
        difficulty: fontGradeToDifficultyId(ascent.grade),
        isBenchmark: false,
        comment: '',
        climbedAt,
        createdAt: ascent.created_at ? normalizeTimestamp(ascent.created_at) : now,
        updatedAt: now,
        auroraType: 'ascents' as const,
        auroraId: generateJsonImportAuroraId(userId, climbUuid, ascent.angle, climbedAt, 'ascents'),
        auroraSyncedAt: now,
      });
      return rows;
    }, []);

    // Step 6: Collect attempt rows to insert
    const attemptRows = data.attempts.reduce<TickRow[]>((rows, attempt) => {
      const climbUuid = nameToUuid.get(attempt.climb);
      if (!climbUuid) { result.attempts.failed++; return rows; }

      const climbedAt = normalizeTimestamp(attempt.climbed_at);
      const tickKey = `${climbUuid}:${attempt.angle}:${climbedAt}`;
      if (existingKeys.has(tickKey)) { result.attempts.skipped++; return rows; }

      existingKeys.add(tickKey);
      rows.push({
        uuid: randomUUID(),
        userId,
        boardType,
        climbUuid,
        angle: attempt.angle,
        isMirror: false,
        status: 'attempt',
        attemptCount: attempt.count,
        quality: null,
        difficulty: null,
        isBenchmark: false,
        comment: '',
        climbedAt,
        createdAt: attempt.created_at ? normalizeTimestamp(attempt.created_at) : now,
        updatedAt: now,
        auroraType: 'bids' as const,
        auroraId: generateJsonImportAuroraId(userId, climbUuid, attempt.angle, climbedAt, 'bids'),
        auroraSyncedAt: now,
      });
      return rows;
    }, []);

    // Step 7: Batch-insert ascents and attempts in a transaction
    await client.query('BEGIN');

    try {
      result.ascents.imported = await batchInsertTicks(
        db, ascentRows,
        {
          climbUuid: sql`excluded.climb_uuid`,
          angle: sql`excluded.angle`,
          status: sql`excluded.status`,
          attemptCount: sql`excluded.attempt_count`,
          quality: sql`excluded.quality`,
          difficulty: sql`excluded.difficulty`,
          climbedAt: sql`excluded.climbed_at`,
          updatedAt: sql`excluded.updated_at`,
          auroraSyncedAt: sql`excluded.aurora_synced_at`,
        },
        'ascents', data.ascents.length, onProgress,
      );

      result.attempts.imported = await batchInsertTicks(
        db, attemptRows,
        {
          climbUuid: sql`excluded.climb_uuid`,
          angle: sql`excluded.angle`,
          attemptCount: sql`excluded.attempt_count`,
          climbedAt: sql`excluded.climbed_at`,
          updatedAt: sql`excluded.updated_at`,
          auroraSyncedAt: sql`excluded.aurora_synced_at`,
        },
        'attempts', data.attempts.length, onProgress,
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    // Step 8: Import circuits as playlists (separate transaction per circuit
    // so one failure doesn't roll back others or abort the tick transaction)
    for (let ci = 0; ci < data.circuits.length; ci++) {
      const circuit = data.circuits[ci];
      const resolvedClimbs = circuit.climbs
        .map((name) => nameToUuid.get(name))
        .filter((uuid): uuid is string => uuid != null);

      const circuitHash = createHash('sha256')
        .update(`${userId}:${boardType}:${circuit.name}:${circuit.created_at}`)
        .digest('hex')
        .slice(0, 32);
      const circuitAuroraId = `json-import-circuit-${circuitHash}`;
      const formattedColor = circuit.color ? `#${circuit.color}` : null;
      const circuitNow = new Date();

      try {
        await client.query('BEGIN');

        const [playlist] = await db
          .insert(playlists)
          .values({
            uuid: randomUUID(),
            boardType,
            layoutId: null,
            name: circuit.name,
            description: circuit.description ?? null,
            isPublic: false,
            color: formattedColor,
            auroraType: 'circuits',
            auroraId: circuitAuroraId,
            auroraSyncedAt: circuitNow,
            createdAt: circuit.created_at ? new Date(circuit.created_at) : circuitNow,
            updatedAt: circuitNow,
          })
          .onConflictDoUpdate({
            target: playlists.auroraId,
            set: {
              name: circuit.name,
              description: circuit.description ?? null,
              isPublic: false,
              color: formattedColor,
              updatedAt: circuitNow,
              auroraSyncedAt: circuitNow,
            },
          })
          .returning({ id: playlists.id });

        await db
          .insert(playlistOwnership)
          .values({
            playlistId: playlist.id,
            userId,
            role: 'owner',
          })
          .onConflictDoNothing();

        // Only replace playlist climbs when we have resolved climbs to insert.
        // This avoids wiping out previously-resolved climbs if name resolution
        // fails on a re-import (e.g., climb was renamed/delisted).
        if (resolvedClimbs.length > 0) {
          await db.delete(playlistClimbs).where(eq(playlistClimbs.playlistId, playlist.id));

          // Batch-insert playlist climbs
          const climbValues = resolvedClimbs.map((climbUuid, i) => ({
            playlistId: playlist.id,
            climbUuid,
            angle: null as number | null,
            position: i,
          }));

          for (let i = 0; i < climbValues.length; i += BATCH_SIZE) {
            await db.insert(playlistClimbs).values(climbValues.slice(i, i + BATCH_SIZE));
          }
        }

        await client.query('COMMIT');
        result.circuits.imported++;
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to import circuit "${circuit.name}":`, error);
        result.circuits.failed++;
      }

      onProgress?.({ type: 'progress', step: 'circuits', current: ci + 1, total: data.circuits.length });
    }

    // Step 9: Build inferred sessions for imported ticks (skipped during chunked imports
    // until the final chunk to avoid rebuilding sessions on every batch).
    // Always run on the final chunk — earlier chunks may have imported ticks even if
    // this chunk only contains circuits.
    if (!options?.skipSessionBuild) {
      onProgress?.({ type: 'progress', step: 'sessions', message: 'Building sessions...' });
      try {
        const assigned = await buildInferredSessionsForUser(userId);
        if (assigned > 0) {
          console.log(`Built inferred sessions: assigned ${assigned} ticks for user ${userId}`);
        }
      } catch (error) {
        console.error('Error building inferred sessions after JSON import:', error);
      }
    }

    return result;
  } finally {
    client.release();
  }
}
