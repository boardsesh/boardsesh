import { z } from 'zod';
import { eq, and, or, inArray, sql, isNull, ilike } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  boardseshTicks,
  boardClimbs,
  boardClimbStats,
  playlists,
  playlistClimbs,
  playlistOwnership,
} from '@boardsesh/db/schema';
import { randomUUID, createHash } from 'crypto';
import { fontGradeToDifficultyId } from '@boardsesh/board-config';
import { LAYOUTS, HOLE_PLACEMENTS } from '@boardsesh/board-constants/product-sizes';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { populateDenormalizedColumns } from '@boardsesh/db/queries';

const BATCH_SIZE = 100;
const FALLBACK_NAME_CHUNK_SIZE = 50;
const MIN_FALLBACK_NAME_KEY_LENGTH = 3;

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

export type ClimbNameResolutionCandidate = {
  uuid: string;
  name: string | null;
  ascensionistCount: number | null;
  isListed: boolean | null;
  isDraft: boolean | null;
  userId: string | null;
};

type ClimbNameResolutionMatch = {
  uuid: string;
  count: number;
  tier: number;
};

// ---------------------------------------------------------------------------
// Import result types
// ---------------------------------------------------------------------------

export type ImportCounts = {
  imported: number;
  skipped: number;
  failed: number;
};

export type ImportResult = {
  ascents: ImportCounts;
  attempts: ImportCounts;
  circuits: ImportCounts;
  climbs: ImportCounts;
  unresolvedClimbs: string[];
  unresolvedAscentClimbs: string[];
  unresolvedAttemptClimbs: string[];
  unresolvedCircuitClimbs: string[];
  // Set by the streaming client when an earlier chunk committed but a later
  // chunk failed — keeps the user from being told the whole import failed.
  partialError?: string;
};

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
// Climb name normalization
// ---------------------------------------------------------------------------

const VARIATION_SELECTOR_AND_JOINER_PATTERN = /\u{200D}|\u{FE0E}|\u{FE0F}/gu;
const EMOJI_AND_PRESENTATION_PATTERN = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u{200D}|\u{FE0E}|\u{FE0F}/gu;
const EMOJI_PLACEHOLDER_REGEX_SOURCE = '[\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\u200d\\ufe0e\\ufe0f]+';

function compactResolutionName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeAuroraExportClimbNameForResolution(name: string): string {
  return compactResolutionName(name.replace(/\?/g, '').replace(VARIATION_SELECTOR_AND_JOINER_PATTERN, ''));
}

export function normalizeBoardClimbNameForAuroraExportResolution(name: string): string {
  return compactResolutionName(name.replace(EMOJI_AND_PRESENTATION_PATTERN, ''));
}

function boardClimbNameHasEmojiForAuroraExportResolution(name: string): boolean {
  return name.replace(EMOJI_AND_PRESENTATION_PATTERN, '') !== name;
}

function escapeRegExpPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildQuestionPlaceholderRegExp(name: string): RegExp {
  const source = name.split(/\?+/g).map(escapeRegExpPattern).join(EMOJI_PLACEHOLDER_REGEX_SOURCE);
  return new RegExp(`^${source}$`, 'u');
}

export function doesBoardClimbNameMatchAuroraQuestionPlaceholder(exportName: string, boardClimbName: string): boolean {
  if (!boardClimbNameHasEmojiForAuroraExportResolution(boardClimbName)) return false;

  const exportKey = normalizeAuroraExportClimbNameForResolution(exportName);
  const boardClimbKey = normalizeBoardClimbNameForAuroraExportResolution(boardClimbName);
  if (exportKey !== boardClimbKey) return false;

  return buildQuestionPlaceholderRegExp(exportName.normalize('NFKC')).test(boardClimbName.normalize('NFKC'));
}

// Escape LIKE/ILIKE metacharacters so export names are matched literally except
// for Aurora's `?` placeholders, which we intentionally turn into wildcards.
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[_%]/g, (match) => `\\${match}`);
}

function buildQuestionPlaceholderLikePattern(name: string): string | null {
  const normalizedKey = normalizeAuroraExportClimbNameForResolution(name);
  if (normalizedKey.length < MIN_FALLBACK_NAME_KEY_LENGTH) return null;

  const pattern = escapeLikePattern(name).replace(/\?+/g, '%');
  return pattern.includes('%') ? pattern : null;
}

export function isClimbNameResolutionCandidateAllowed(
  candidate: ClimbNameResolutionCandidate,
  userId?: string,
): boolean {
  const isNonDraft = candidate.isDraft !== true;
  const isCatalogOrPublic = isNonDraft && (candidate.isListed === true || candidate.userId == null);
  const isUsersOwnClimb = userId != null && candidate.userId === userId;
  return isCatalogOrPublic || isUsersOwnClimb;
}

function getClimbNameResolutionCandidateTier(candidate: ClimbNameResolutionCandidate, userId?: string): number {
  const isNonDraft = candidate.isDraft !== true;
  if (isNonDraft && candidate.isListed === true) return 3;
  if (userId != null && candidate.userId === userId) return 2;
  if (isNonDraft && candidate.userId == null) return 1;
  return 0;
}

function isBetterClimbNameResolutionCandidate(
  candidate: ClimbNameResolutionCandidate,
  candidateMatch: ClimbNameResolutionMatch,
  existingMatch?: ClimbNameResolutionMatch,
): boolean {
  if (!existingMatch) return true;
  if (candidateMatch.tier !== existingMatch.tier) return candidateMatch.tier > existingMatch.tier;
  if (candidateMatch.count !== existingMatch.count) return candidateMatch.count > existingMatch.count;
  return candidate.uuid < existingMatch.uuid;
}

function addClimbNameResolutionCandidate(
  nameToMatch: Map<string, ClimbNameResolutionMatch>,
  exportName: string,
  candidate: ClimbNameResolutionCandidate,
  userId?: string,
): void {
  if (!candidate.name || !isClimbNameResolutionCandidateAllowed(candidate, userId)) return;

  const candidateMatch: ClimbNameResolutionMatch = {
    uuid: candidate.uuid,
    count: candidate.ascensionistCount ?? 0,
    tier: getClimbNameResolutionCandidateTier(candidate, userId),
  };
  const existingMatch = nameToMatch.get(exportName);

  if (isBetterClimbNameResolutionCandidate(candidate, candidateMatch, existingMatch)) {
    nameToMatch.set(exportName, candidateMatch);
  }
}

export function resolveQuestionPlaceholderClimbNameForCandidates(
  exportName: string,
  candidates: ClimbNameResolutionCandidate[],
  userId?: string,
): string | null {
  const exportKey = normalizeAuroraExportClimbNameForResolution(exportName);
  if (exportKey.length < MIN_FALLBACK_NAME_KEY_LENGTH) return null;

  const nameToMatch = new Map<string, ClimbNameResolutionMatch>();
  for (const candidate of candidates) {
    if (!candidate.name) continue;
    if (!doesBoardClimbNameMatchAuroraQuestionPlaceholder(exportName, candidate.name)) continue;
    addClimbNameResolutionCandidate(nameToMatch, exportName, candidate, userId);
  }

  return nameToMatch.get(exportName)?.uuid ?? null;
}

// ---------------------------------------------------------------------------
// Climb draft import helpers
// ---------------------------------------------------------------------------

/** Map export role names to board-specific hold state codes. */
const ROLE_TO_CODE: Partial<Record<AuroraBoardName, Record<string, number>>> = {
  kilter: { start: 42, middle: 43, finish: 44, foot: 45 },
  tension: { start: 1, middle: 2, finish: 3, foot: 4 },
  decoy: { start: 1, middle: 2, finish: 3, foot: 4 },
  touchstone: { start: 1, middle: 2, finish: 3, foot: 4 },
  grasshopper: { start: 1, middle: 2, finish: 3, foot: 4 },
  soill: { start: 1, middle: 2, finish: 3, foot: 4 },
};

/** Resolve a layout name (e.g. "Kilter Board Original") to a layout ID. */
export function resolveLayoutName(boardType: BoardType, layoutName: string): number | null {
  const layouts = LAYOUTS[boardType as keyof typeof LAYOUTS];
  if (!layouts) return null;
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
  const boardPlacements = HOLE_PLACEMENTS[boardType as keyof typeof HOLE_PLACEMENTS];

  if (!boardPlacements) {
    coordinateMapCache.set(cacheKey, coordMap);
    return coordMap;
  }

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
  if (!roleCodes) return null; // Board doesn't support climb draft import
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
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
} | null {
  if (holds.length === 0) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
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
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  boardType: BoardType,
  climbNames: string[],
  userId?: string,
): Promise<Map<string, string>> {
  if (climbNames.length === 0) return new Map();

  // Track best match across all chunks.
  const nameToMatch = new Map<string, ClimbNameResolutionMatch>();

  const eligibleCatalogOrPublicFilter = and(
    or(eq(boardClimbs.isDraft, false), isNull(boardClimbs.isDraft)),
    or(eq(boardClimbs.isListed, true), isNull(boardClimbs.userId)),
  );

  // Batch in chunks of 500 to avoid overly large IN clauses
  const chunkSize = 500;
  for (let i = 0; i < climbNames.length; i += chunkSize) {
    const chunk = climbNames.slice(i, i + chunkSize);

    // Query exact name matches with stats to pick the most popular when
    // duplicates exist. Aurora catalog climbs can be delisted after a user
    // logged them, so non-draft catalog rows stay eligible even when
    // is_listed=false.
    const catalogOrPublicFilter = and(
      eq(boardClimbs.boardType, boardType),
      inArray(boardClimbs.name, chunk),
      eligibleCatalogOrPublicFilter,
    );

    // Also match the user's own imported/local climbs so ascents/circuits
    // referencing them resolve.
    const userOwnedFilter = userId
      ? and(eq(boardClimbs.boardType, boardType), inArray(boardClimbs.name, chunk), eq(boardClimbs.userId, userId))
      : undefined;

    const whereClause = userOwnedFilter ? or(catalogOrPublicFilter, userOwnedFilter) : catalogOrPublicFilter;

    const results = await db
      .select({
        uuid: boardClimbs.uuid,
        name: boardClimbs.name,
        ascensionistCount: boardClimbStats.ascensionistCount,
        isListed: boardClimbs.isListed,
        isDraft: boardClimbs.isDraft,
        userId: boardClimbs.userId,
      })
      .from(boardClimbs)
      .leftJoin(
        boardClimbStats,
        and(eq(boardClimbStats.climbUuid, boardClimbs.uuid), eq(boardClimbStats.boardType, boardClimbs.boardType)),
      )
      .where(whereClause);

    for (const row of results) {
      if (!row.name) continue;
      addClimbNameResolutionCandidate(nameToMatch, row.name, row, userId);
    }
  }

  const unresolvedQuestionNames = climbNames.filter((name) => !nameToMatch.has(name) && name.includes('?'));
  if (unresolvedQuestionNames.length > 0) {
    await resolveQuestionPlaceholderClimbNames(
      db,
      boardType,
      unresolvedQuestionNames,
      eligibleCatalogOrPublicFilter,
      nameToMatch,
      userId,
    );
  }

  // Convert to simple name -> uuid map
  return new Map([...nameToMatch].map(([name, match]) => [name, match.uuid]));
}

async function resolveQuestionPlaceholderClimbNames(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  boardType: BoardType,
  climbNames: string[],
  eligibleCatalogOrPublicFilter: ReturnType<typeof and>,
  nameToMatch: Map<string, ClimbNameResolutionMatch>,
  userId?: string,
): Promise<void> {
  const fallbackRequests = climbNames
    .map((name) => ({
      name,
      normalizedKey: normalizeAuroraExportClimbNameForResolution(name),
      pattern: buildQuestionPlaceholderLikePattern(name),
    }))
    .filter(
      (
        request,
      ): request is {
        name: string;
        normalizedKey: string;
        pattern: string;
      } => request.pattern != null && request.normalizedKey.length >= MIN_FALLBACK_NAME_KEY_LENGTH,
    );

  for (let i = 0; i < fallbackRequests.length; i += FALLBACK_NAME_CHUNK_SIZE) {
    const chunk = fallbackRequests.slice(i, i + FALLBACK_NAME_CHUNK_SIZE);
    const patterns = new Set<string>();

    for (const request of chunk) {
      patterns.add(request.pattern);
    }

    const namePatternFilters = [...patterns].map((pattern) => ilike(boardClimbs.name, pattern));
    const userOwnedFilter = userId ? eq(boardClimbs.userId, userId) : undefined;
    const eligibilityFilter = userOwnedFilter
      ? or(eligibleCatalogOrPublicFilter, userOwnedFilter)
      : eligibleCatalogOrPublicFilter;

    const results = await db
      .select({
        uuid: boardClimbs.uuid,
        name: boardClimbs.name,
        ascensionistCount: boardClimbStats.ascensionistCount,
        isListed: boardClimbs.isListed,
        isDraft: boardClimbs.isDraft,
        userId: boardClimbs.userId,
      })
      .from(boardClimbs)
      .leftJoin(
        boardClimbStats,
        and(eq(boardClimbStats.climbUuid, boardClimbs.uuid), eq(boardClimbStats.boardType, boardClimbs.boardType)),
      )
      .where(and(eq(boardClimbs.boardType, boardType), eligibilityFilter, or(...namePatternFilters)));

    for (const row of results) {
      if (!row.name) continue;

      for (const request of chunk) {
        if (!doesBoardClimbNameMatchAuroraQuestionPlaceholder(request.name, row.name)) continue;
        addClimbNameResolutionCandidate(nameToMatch, request.name, row, userId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-source dedup: fetch existing tick keys for this user + board
// ---------------------------------------------------------------------------

async function getExistingTickKeys(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
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
    .where(and(eq(boardseshTicks.userId, userId), eq(boardseshTicks.boardType, boardType)));

  return new Set(
    existing.map((row) => {
      const normalized = normalizeTimestamp(row.climbedAt);
      return `${row.climbUuid}:${row.angle}:${normalized}`;
    }),
  );
}

// ---------------------------------------------------------------------------
// Flash-status correction
// ---------------------------------------------------------------------------

/**
 * Correct flash/send labels for one user across all their ticks.
 *
 * A "flash" is the first-ever tick of a (climb_uuid, angle) pair, sent in a
 * single attempt. The Aurora export only gives us per-session attempt counts,
 * not first-ever-ness, so the importer writes everything as 'send' and we
 * fix things here once all their history is in the DB.
 *
 * Two statements because PostgreSQL's UPDATE doesn't see its own mid-statement
 * changes — the promotion must commit before the demotion's prior-tick check
 * can rely on it.
 */
export async function correctFlashStatusForUser(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  userId: string,
): Promise<void> {
  // Materialize per-(climb_uuid, angle) MIN(climbed_at) once, then drive both
  // updates off it. Cheaper than the correlated NOT EXISTS / EXISTS variant on
  // users with thousands of ticks. Same shape as migration 0108.
  await db.execute(sql`
    WITH first_ticks AS (
      SELECT climb_uuid, angle, MIN(climbed_at) AS first_climbed_at
      FROM boardsesh_ticks
      WHERE user_id = ${userId}
      GROUP BY climb_uuid, angle
    )
    UPDATE boardsesh_ticks t
    SET status = 'flash'
    FROM first_ticks f
    WHERE t.user_id = ${userId}
      AND t.climb_uuid = f.climb_uuid
      AND t.angle = f.angle
      AND t.climbed_at = f.first_climbed_at
      AND t.attempt_count = 1
      AND t.status = 'send'
  `);

  await db.execute(sql`
    WITH first_ticks AS (
      SELECT climb_uuid, angle, MIN(climbed_at) AS first_climbed_at
      FROM boardsesh_ticks
      WHERE user_id = ${userId}
      GROUP BY climb_uuid, angle
    )
    UPDATE boardsesh_ticks t
    SET status = 'send'
    FROM first_ticks f
    WHERE t.user_id = ${userId}
      AND t.climb_uuid = f.climb_uuid
      AND t.angle = f.angle
      AND t.climbed_at > f.first_climbed_at
      AND t.status = 'flash'
  `);
}

// ---------------------------------------------------------------------------
// Batch insert helper
// ---------------------------------------------------------------------------

async function batchInsertTicks(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
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

    await db.insert(boardseshTicks).values(batch).onConflictDoUpdate({
      target: boardseshTicks.auroraId,
      set: conflictSet,
    });

    imported += batch.length;
    onProgress?.({
      type: 'progress',
      step,
      current: Math.min(i + BATCH_SIZE, rows.length),
      total: rows.length,
    });
  }

  return imported;
}

// ---------------------------------------------------------------------------
// Main import function
// ---------------------------------------------------------------------------

export async function importJsonExportData(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  userId: string,
  boardType: BoardType,
  data: AuroraExportData,
  onProgress?: (event: ImportProgressEvent) => void,
  options?: { skipFinalization?: boolean },
): Promise<ImportResult> {
  const result: ImportResult = {
    ascents: { imported: 0, skipped: 0, failed: 0 },
    attempts: { imported: 0, skipped: 0, failed: 0 },
    circuits: { imported: 0, skipped: 0, failed: 0 },
    climbs: { imported: 0, skipped: 0, failed: 0 },
    unresolvedClimbs: [],
    unresolvedAscentClimbs: [],
    unresolvedAttemptClimbs: [],
    unresolvedCircuitClimbs: [],
  };

  // Capture a single "now" for all timestamps in this import
  const now = new Date().toISOString();

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
            and(eq(boardClimbs.boardType, boardType), inArray(boardClimbs.name, chunk), eq(boardClimbs.isDraft, false)),
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
      if (layoutId == null) {
        result.climbs.failed++;
        continue;
      }

      const coordMap = buildCoordinateMap(boardType, layoutId);
      const frames = convertHoldsToFrames(climb.holds, coordMap, boardType);
      if (!frames) {
        result.climbs.failed++;
        continue;
      }

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
      if (layoutId == null) {
        result.climbs.failed++;
        continue;
      }

      const coordMap = buildCoordinateMap(boardType, layoutId);
      const frames = convertHoldsToFrames(climb.holds, coordMap, boardType);
      if (!frames) {
        result.climbs.failed++;
        continue;
      }

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
      await db.transaction(async (tx) => {
        // Insert draft climbs with upsert (re-import updates them)
        for (let i = 0; i < draftRows.length; i += BATCH_SIZE) {
          const batch = draftRows.slice(i, i + BATCH_SIZE);
          await tx
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
          await tx.insert(boardClimbs).values(batch).onConflictDoNothing();
          result.climbs.imported += batch.length;
        }

        // Populate denormalized required_set_ids and compatible_size_ids
        const allInsertedUuids = [...draftRows.map((r) => r.uuid), ...publishedRows.map((r) => r.uuid)];
        await populateDenormalizedColumns(tx, boardType, allInsertedUuids);
      });
    }

    onProgress?.({
      type: 'progress',
      step: 'climbs',
      current: data.climbs.length,
      total: data.climbs.length,
    });
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
  onProgress?.({
    type: 'progress',
    step: 'resolving',
    message: `Resolving ${allClimbNames.size} climb names...`,
  });
  const nameToUuid = await resolveClimbNames(db, boardType, [...allClimbNames], userId);

  // Track unresolved names, split per-source so the UI can show each section
  // separately (an ascent with an unmatched climb is a different user story
  // from a circuit referencing an unmatched climb).
  const unresolvedAscentSet = new Set<string>();
  const unresolvedAttemptSet = new Set<string>();
  const unresolvedCircuitSet = new Set<string>();
  for (const ascent of data.ascents) {
    if (!nameToUuid.has(ascent.climb)) unresolvedAscentSet.add(ascent.climb);
  }
  for (const attempt of data.attempts) {
    if (!nameToUuid.has(attempt.climb)) unresolvedAttemptSet.add(attempt.climb);
  }
  for (const circuit of data.circuits) {
    for (const climbName of circuit.climbs) {
      if (!nameToUuid.has(climbName)) unresolvedCircuitSet.add(climbName);
    }
  }
  result.unresolvedAscentClimbs = [...unresolvedAscentSet].sort();
  result.unresolvedAttemptClimbs = [...unresolvedAttemptSet].sort();
  result.unresolvedCircuitClimbs = [...unresolvedCircuitSet].sort();
  result.unresolvedClimbs = [...allClimbNames].filter((name) => !nameToUuid.has(name));

  // Step 4: Get existing tick keys for cross-source dedup
  onProgress?.({ type: 'progress', step: 'dedup', message: 'Checking for duplicates...' });
  const existingKeys = await getExistingTickKeys(db, userId, boardType);

  // Step 5: Collect ascent rows to insert (in-memory dedup first)
  type TickRow = typeof boardseshTicks.$inferInsert;

  const ascentRows = data.ascents.reduce<TickRow[]>((rows, ascent) => {
    const climbUuid = nameToUuid.get(ascent.climb);
    if (!climbUuid) {
      result.ascents.failed++;
      return rows;
    }

    const climbedAt = normalizeTimestamp(ascent.climbed_at);
    const tickKey = `${climbUuid}:${ascent.angle}:${climbedAt}`;
    if (existingKeys.has(tickKey)) {
      result.ascents.skipped++;
      return rows;
    }

    existingKeys.add(tickKey);
    rows.push({
      uuid: randomUUID(),
      userId,
      boardType,
      climbUuid,
      angle: ascent.angle,
      isMirror: false,
      // Conservative initial value. Aurora's `count` is attempts within a
      // single climbed_at session, not "no prior attempts ever" — so we can't
      // call this a flash here. correctFlashStatusForUser runs on the final
      // chunk and promotes true first-evers across the user's full history.
      status: 'send',
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
    if (!climbUuid) {
      result.attempts.failed++;
      return rows;
    }

    const climbedAt = normalizeTimestamp(attempt.climbed_at);
    const tickKey = `${climbUuid}:${attempt.angle}:${climbedAt}`;
    if (existingKeys.has(tickKey)) {
      result.attempts.skipped++;
      return rows;
    }

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
  await db.transaction(async (tx) => {
    result.ascents.imported = await batchInsertTicks(
      tx,
      ascentRows,
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
      'ascents',
      data.ascents.length,
      onProgress,
    );

    result.attempts.imported = await batchInsertTicks(
      tx,
      attemptRows,
      {
        climbUuid: sql`excluded.climb_uuid`,
        angle: sql`excluded.angle`,
        attemptCount: sql`excluded.attempt_count`,
        climbedAt: sql`excluded.climbed_at`,
        updatedAt: sql`excluded.updated_at`,
        auroraSyncedAt: sql`excluded.aurora_synced_at`,
      },
      'attempts',
      data.attempts.length,
      onProgress,
    );
  });

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
      await db.transaction(async (tx) => {
        const [playlist] = await tx
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

        await tx
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
          await tx.delete(playlistClimbs).where(eq(playlistClimbs.playlistId, playlist.id));

          // Batch-insert playlist climbs
          const climbValues = resolvedClimbs.map((climbUuid, i) => ({
            playlistId: playlist.id,
            climbUuid,
            angle: null as number | null,
            position: i,
          }));

          for (let i = 0; i < climbValues.length; i += BATCH_SIZE) {
            await tx.insert(playlistClimbs).values(climbValues.slice(i, i + BATCH_SIZE));
          }
        }
      });
      result.circuits.imported++;
    } catch (error) {
      console.error(`Failed to import circuit "${circuit.name}":`, error);
      result.circuits.failed++;
    }

    onProgress?.({
      type: 'progress',
      step: 'circuits',
      current: ci + 1,
      total: data.circuits.length,
    });
  }

  // Step 9: Final-chunk-only status correction. Earlier chunks may have
  // imported ticks even if this chunk only contains circuits, so always run
  // when not skipped. This is best-effort: the user's ticks are already
  // committed, but we surface failure on `partialError` so the UI can warn
  // them their flashes may need a re-run.
  if (!options?.skipFinalization) {
    try {
      await correctFlashStatusForUser(db, userId);
    } catch (error) {
      console.error('Error correcting flash status after JSON import:', error);
      const msg = error instanceof Error ? error.message : 'Flash status correction failed';
      result.partialError = result.partialError ? `${result.partialError}\n${msg}` : msg;
    }
  }

  return result;
}
