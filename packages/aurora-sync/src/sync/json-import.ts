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
import {
  isNoMatchClimb,
  CLIMB_CHARACTERISTICS,
  convertQuality,
  normalizePlaylistColor,
} from '@boardsesh/shared-schema';
import {
  mergeCatalogCharacteristicsSql,
  populateDenormalizedColumns,
  recomputeClimbStatsBulk,
  foreignPlaylistOwnerGuard,
  type ClimbStatsKey,
} from '@boardsesh/db/queries';
import {
  resolveUpstreamPlaylistWrite,
  canWriteUpstreamPlaylist,
  upstreamPlaylistSkipLogLine,
} from '@boardsesh/sync-runtime';
import { normalizeTimestamp } from './normalize-timestamp';

// Re-exported so existing importers (`@boardsesh/aurora-sync/json-import`, and
// the `./sync` barrel) keep resolving `normalizeTimestamp` from here. The
// canonical definition now lives in ./normalize-timestamp so the live Aurora
// pull can share it without pulling in this module's heavy board-config deps.
export { normalizeTimestamp };

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
  // The legacy Kilter export always carries stars + grade on an ascent. The
  // live Aurora backend (Tension / TB2) instead delivers the WHOLE logbook in
  // `ascents` and flags a bid the user never sent with `is_ascent: false` —
  // those attempt-shaped rows can lack stars/grade, so both are optional. A
  // missing/true `is_ascent` keeps the row an ascent (legacy path unchanged);
  // an explicit false reroutes it to the attempt path. #3301
  stars: z.number().optional(),
  climbed_at: z.string(),
  created_at: z.string(),
  grade: z.string().optional(),
  is_ascent: z.boolean().optional(),
  tries: z.number().optional(),
  // Declared so zod stops silently stripping it: an undeclared key never
  // reaches the row builder, which is why every imported tick was written
  // non-mirrored (#3521). Typed `unknown` rather than `z.boolean()` on
  // purpose — the export is a bespoke rendering, not the API shape, so we
  // don't know how it encodes booleans. A strict boolean would reject the
  // WHOLE import with a 400 if Aurora emits `1` / `"true"` / `null`, which
  // is a far worse failure than the orientation bug. `readExportBool` does
  // the coercion instead, exactly like the live pull's `toBool`.
  is_mirror: z.unknown().optional(),
});

export type AuroraExportAscent = z.infer<typeof auroraExportAscentSchema>;

const auroraExportAttemptSchema = z.object({
  climb: z.string(),
  angle: z.number(),
  count: z.number(),
  climbed_at: z.string(),
  created_at: z.string(),
  // Same reasoning as the ascent schema above (#3521). Attempts matter as much
  // as sends here: Tension/TB2 — the board where a quarter of live ticks are
  // mirrored — delivers its bids inside `ascents` with `is_ascent: false`, and
  // those records flow through `exportAscentToAttempt` into this shape.
  is_mirror: z.unknown().optional(),
});

export type AuroraExportAttempt = z.infer<typeof auroraExportAttemptSchema>;

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
 * Coerce an export flag whose wire encoding we can't pin down. Mirrors the live
 * pull's `toBool` (apply-user-logbook.ts) so both sync paths agree on what
 * counts as true, and treats anything else — including a missing field, which
 * is every legacy Kilter export — as false. #3521
 */
export function readExportBool(value: unknown): boolean {
  if (typeof value === 'string') {
    // Case-insensitive on the string form, which `toBool` isn't: the export is
    // rendered by some Aurora-side script we've never seen, and a stringified
    // boolean from most languages comes out title-case ("True"). Reading one
    // more spelling costs nothing; missing it would silently drop the flag all
    // over again.
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
  }
  return value === true || value === 1;
}

/**
 * The synthetic `aurora_id` for an imported tick.
 *
 * FROZEN: the inputs to this hash must not change. Every previously imported
 * tick carries the resulting id in `boardsesh_ticks.aurora_id`, where it is
 * both the ON CONFLICT arbiter for a re-import (see `batchInsertTicks`) and the
 * handle the live Aurora pull uses to claim placeholders (`aurora_id LIKE
 * 'json-import-%'`). Adding a field rewrites every id in place, which severs
 * the upsert channel that in-place corrections depend on — the #3390 quality
 * rescale and the #3301 attempt heal both reached existing rows through it —
 * and orphans rows whose stored climbed_at has since been moved by the live
 * pull. Changing this is a data-integrity event needing a migration and human
 * sign-off, not a refactor; `json-import.test.ts` pins the output to catch it.
 *
 * In particular, mirror is deliberately NOT part of the key (#3521): see the
 * dedup comment in `importJsonExportData` for why the natural key can't carry
 * it either.
 */
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

/**
 * Deterministic `playlists.aurora_id` for an imported circuit. USER-SCOPED, and
 * that is the whole point: the original importer (8fe79f60d) hashed only
 * `${boardType}:${name}:${created_at}`, so two people importing a circuit with
 * the same name and creation timestamp collided on the global
 * `playlists_aurora_id_idx` — the second importer's ON CONFLICT adopted the
 * first's playlist and took an `owner` edge on it. 45cef340a added the user id;
 * 36 cross-linked playlists from that window are still in prod (#3526/#3541).
 * Never remove `userId` from this key.
 */
export function generateJsonImportCircuitAuroraId(
  userId: string,
  boardType: BoardType,
  circuitName: string,
  createdAt: string,
): string {
  const hash = createHash('sha256')
    .update(`${userId}:${boardType}:${circuitName}:${createdAt}`)
    .digest('hex')
    .slice(0, 32);
  return `json-import-circuit-${hash}`;
}

/**
 * Resolve an export circuit's climb NAMES to climb uuids, dropping unresolved
 * names and collapsing repeats.
 *
 * The dedupe is load-bearing, not tidiness: `unique_playlist_climb` is
 * (playlist_id, climb_uuid), so a circuit that lists the same climb twice — or
 * two distinct names that resolve to one uuid — produced duplicate rows and a
 * raw 23505 that rolled the whole circuit's transaction back. The climber saw a
 * bumped `failed` count and a silently missing circuit. Same index exposure the
 * user-sync circuits branch fixes in #4023; extracted so it is testable without
 * a database.
 */
export function resolveCircuitClimbUuids(climbNames: string[], nameToUuid: Map<string, string>): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const name of climbNames) {
    const uuid = nameToUuid.get(name);
    if (uuid == null || seen.has(uuid)) continue;
    seen.add(uuid);
    resolved.push(uuid);
  }
  return resolved;
}

export type JsonImportTickRow = typeof boardseshTicks.$inferInsert;

/**
 * Map one export ascent to a boardsesh_ticks insert row. Extracted from the
 * import loop so the field mapping — in particular the stars -> quality
 * scale conversion — is unit-testable without a database.
 */
export function buildJsonImportAscentTickRow(
  userId: string,
  boardType: BoardType,
  ascent: AuroraExportAscent,
  climbUuid: string,
  climbedAt: string,
  now: string,
): JsonImportTickRow {
  return {
    uuid: randomUUID(),
    userId,
    boardType,
    climbUuid,
    angle: ascent.angle,
    // Absent from the export (every legacy Kilter file) → false, exactly as
    // before. Present → recorded, instead of being thrown away. #3521
    isMirror: readExportBool(ascent.is_mirror),
    // Conservative initial value. Aurora's `count` is attempts within a
    // single climbed_at session, not "no prior attempts ever" — so we can't
    // call this a flash here. correctFlashStatusForUser runs on the final
    // chunk and promotes true first-evers across the user's full history.
    status: 'send',
    attemptCount: ascent.count,
    // The JSON export 'stars' field is the raw Aurora 0-3 rating, same as
    // the API 'quality' field — NOT the user-facing 1-5 scale. Convert it
    // like the API sync path does (0 -> null, 1 -> 1, 2 -> 3, 3 -> 5).
    // Rows imported before this conversion existed were rescaled by the
    // backfill migration scoped to aurora_id LIKE 'json-import-%'.
    quality: convertQuality(ascent.stars),
    // A merged-shape ascent can omit `grade`; fontGradeToDifficultyId('')
    // intentionally returns null (unrecognised grade → no personal override).
    difficulty: fontGradeToDifficultyId(ascent.grade ?? ''),
    isBenchmark: false,
    comment: '',
    climbedAt,
    createdAt: ascent.created_at ? normalizeTimestamp(ascent.created_at) : now,
    updatedAt: now,
    // Imported from an Aurora account export — already inside
    // upstream_ascensionist_count, so origin excludes it from the Boardsesh
    // double-count guard.
    origin: 'json_import' as const,
    auroraType: 'ascents' as const,
    auroraId: generateJsonImportAuroraId(userId, climbUuid, ascent.angle, climbedAt, 'ascents'),
    auroraSyncedAt: now,
  };
}

/**
 * An `ascents` entry that the current Aurora backend (Tension / TB2) marked as
 * a bid the user never sent. The legacy Kilter export splits sends and attempts
 * into separate top-level arrays and never sets this flag, so a missing or true
 * `is_ascent` stays an ascent — the legacy path is byte-for-byte unchanged. Only
 * an explicit `false` reroutes the record to the attempt path. #3301
 */
export function isExportAscentActuallyAttempt(ascent: AuroraExportAscent): boolean {
  return ascent.is_ascent === false;
}

/**
 * Coerce a merged-shape attempt (an `ascents` row with `is_ascent: false`) into
 * the flat attempt shape the importer's attempt path consumes. In the merged
 * shape `tries` is the bid count; fall back to `count` when it's absent.
 */
export function exportAscentToAttempt(ascent: AuroraExportAscent): AuroraExportAttempt {
  return {
    climb: ascent.climb,
    angle: ascent.angle,
    count: ascent.tries ?? ascent.count,
    climbed_at: ascent.climbed_at,
    created_at: ascent.created_at,
    // Carry orientation across the reclassification, or every Tension/TB2 bid
    // — the shape where mirrored logs actually concentrate — would lose it on
    // the way into the attempt path. #3521
    is_mirror: ascent.is_mirror,
  };
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

export type ImportedClimbRow = typeof boardClimbs.$inferInsert;

/**
 * Build a board_climbs insert row for a climb pulled from an Aurora account
 * export. Both draft climbs and published-but-uncatalogued climbs are per-user
 * placeholders — userId-owned and, crucially, is_listed = FALSE. A published
 * placeholder must never surface in catalog search (it is a low-signal duplicate
 * of the real climb the user logged); it exists only to anchor the importer's
 * own ticks, which still resolve via resolveClimbNames' userOwnedFilter. `isDraft`
 * is the only difference between the draft and published variants.
 */
export function buildImportedClimbRow(args: {
  userId: string;
  boardType: BoardType;
  layoutId: number;
  setterUsername: string;
  name: string;
  description: string | null | undefined;
  frames: string;
  edges: { edgeLeft: number; edgeRight: number; edgeBottom: number; edgeTop: number } | null;
  createdAt: string;
  isDraft: boolean;
}): ImportedClimbRow {
  return {
    uuid: generateClimbImportUuid(args.userId, args.boardType, args.layoutId, args.name, args.createdAt),
    boardType: args.boardType,
    layoutId: args.layoutId,
    userId: args.userId,
    setterId: null,
    setterUsername: args.setterUsername,
    name: args.name,
    description: args.description ?? '',
    characteristics: isNoMatchClimb(args.description) ? [CLIMB_CHARACTERISTICS.NO_MATCH] : null,
    frames: args.frames,
    framesCount: 1,
    framesPace: 0,
    isDraft: args.isDraft,
    isListed: false,
    edgeLeft: args.edges?.edgeLeft ?? null,
    edgeRight: args.edges?.edgeRight ?? null,
    edgeBottom: args.edges?.edgeBottom ?? null,
    edgeTop: args.edges?.edgeTop ?? null,
    angle: null,
    createdAt: args.createdAt,
    synced: false,
    syncError: null,
  };
}

/**
 * Key for the layout-aware published-climb skip list: a placeholder is only
 * suppressed when a real catalog climb covers the SAME (layoutId, name) pair —
 * a same-name catalog climb on another layout is a different climb and must not
 * block this layout's placeholder (the import's ascents would have nothing to
 * resolve to). Exported for tests.
 */
export function publishedClimbKey(layoutId: number, name: string): string {
  return `${layoutId}:${name}`;
}

/**
 * ON CONFLICT policy for the published-placeholder batch. A uuid conflict can
 * only be a placeholder this same user imported before (generateClimbImportUuid
 * hashes userId+board+layout+name+createdAt), and the update flips the stored
 * row to the current unlisted policy — healing is_listed=true placeholders left
 * behind by imports made before placeholders went unlisted. The setWhere
 * belt-and-suspenders that invariant: only a 'json-import-climb-' row owned by
 * THIS user is ever updated, so a real catalog climb can never be delisted even
 * if a uuid somehow collided. Exported for tests.
 */
export function importedPlaceholderConflictPolicy(userId: string) {
  return {
    setWhere: and(sql`${boardClimbs.uuid} LIKE 'json-import-climb-%'`, eq(boardClimbs.userId, userId)),
    set: { isListed: sql`excluded.is_listed` },
  };
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

/** Seconds within which two ticks count as the same first ascent (see below). */
const FLASH_CORRECTION_TOLERANCE_SECONDS = 60;

/**
 * Correct flash/send labels for one user on ONE board.
 *
 * A "flash" is the first-ever tick of a (climb_uuid, angle) pair, sent in a
 * single attempt. The Aurora export only gives us per-session attempt counts,
 * not first-ever-ness, so the importer writes everything as 'send' and we fix
 * things here once all their history is in the DB.
 *
 * Scoping (§work-item 8):
 *  - Board-scoped: a Kilter import must not touch the user's Tension flashes.
 *    The first-tick MIN is computed within the imported board only.
 *  - Origin guard: only native/json_import rows are relabelled. aurora_pull /
 *    kilter_pull ticks carry an upstream-authoritative status (Aurora's
 *    attempt_id / Kilter's flashed flag) — never demote or promote those. They
 *    still participate in the MIN so they can be the true first ascent that
 *    demotes a later json_import "flash".
 *  - Timestamp tolerance: only demote a flash that is more than a minute after
 *    the first ascent, so a near-duplicate log of the same session (or clock
 *    jitter) doesn't get spuriously demoted.
 *
 * Two statements because PostgreSQL's UPDATE doesn't see its own mid-statement
 * changes — the promotion must commit before the demotion's prior-tick check
 * can rely on it.
 */
export async function correctFlashStatusForUser(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  userId: string,
  boardType: BoardType,
): Promise<void> {
  // Materialize per-(climb_uuid, angle) MIN(climbed_at) once, then drive both
  // updates off it. Cheaper than the correlated NOT EXISTS / EXISTS variant on
  // users with thousands of ticks. Same shape as migration 0108.
  await db.execute(sql`
    WITH first_ticks AS (
      SELECT climb_uuid, angle, MIN(climbed_at) AS first_climbed_at
      FROM boardsesh_ticks
      WHERE user_id = ${userId}
        AND board_type = ${boardType}
      GROUP BY climb_uuid, angle
    )
    UPDATE boardsesh_ticks t
    SET status = 'flash'
    FROM first_ticks f
    WHERE t.user_id = ${userId}
      AND t.board_type = ${boardType}
      AND t.climb_uuid = f.climb_uuid
      AND t.angle = f.angle
      AND t.climbed_at = f.first_climbed_at
      AND t.attempt_count = 1
      AND t.status = 'send'
      AND t.origin IN ('native','json_import')
  `);

  await db.execute(sql`
    WITH first_ticks AS (
      SELECT climb_uuid, angle, MIN(climbed_at) AS first_climbed_at
      FROM boardsesh_ticks
      WHERE user_id = ${userId}
        AND board_type = ${boardType}
      GROUP BY climb_uuid, angle
    )
    UPDATE boardsesh_ticks t
    SET status = 'send'
    FROM first_ticks f
    WHERE t.user_id = ${userId}
      AND t.board_type = ${boardType}
      AND t.climb_uuid = f.climb_uuid
      AND t.angle = f.angle
      AND t.climbed_at::timestamptz > f.first_climbed_at::timestamptz
                                      + make_interval(secs => ${FLASH_CORRECTION_TOLERANCE_SECONDS})
      AND t.status = 'flash'
      AND t.origin IN ('native','json_import')
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
// Self-healing remediation for #3301
// ---------------------------------------------------------------------------

/** Natural key of a merged-shape attempt whose earlier import may have created a mislabeled send. */
type MislabeledAttemptKey = {
  climbUuid: string;
  angle: number;
  climbedAt: string;
  attemptCount: number;
};

/**
 * Fix rows an earlier (pre-#3301) import mislabeled: a Tension/TB2 attempt that
 * arrived inside the `ascents` array was written as a `send`. When the fixed
 * importer now classifies the SAME record as an attempt, flip the stale row in
 * place — status → 'attempt', clear the star/grade an attempt can't carry, and
 * point aurora_type at 'bids'. Matched strictly on the natural key
 * (climb_uuid, angle, climbed_at) of an existing json_import ascent for this
 * user + board, so a legitimate send is never touched.
 *
 * This is an UPDATE only — it never deletes. `aurora_id` is intentionally left
 * as the original `json-import-…` (ascents) hash: it's still a unique synthetic
 * id, it stays claimable by the live Aurora pull (`aurora_id LIKE 'json-import-%'`),
 * and rewriting it would risk colliding with the global aurora_id unique index.
 * Returns the number of rows healed.
 */
async function healMislabeledJsonImportAttempts(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  boardType: BoardType,
  userId: string,
  keys: MislabeledAttemptKey[],
  now: string,
): Promise<number> {
  if (keys.length === 0) return 0;

  let healed = 0;
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const payload = JSON.stringify(
      batch.map((key) => ({
        climb_uuid: key.climbUuid,
        angle: key.angle,
        climbed_at: key.climbedAt,
        attempt_count: key.attemptCount,
      })),
    );

    const result = await db.execute(sql`
      UPDATE boardsesh_ticks AS t SET
        -- String literals coerce to the column's type (enum in prod, text in the
        -- test schema) by assignment, so no explicit ::enum cast is needed.
        status = 'attempt',
        quality = NULL,
        difficulty = NULL,
        attempt_count = u.attempt_count,
        aurora_type = 'bids',
        updated_at = ${now}::timestamp,
        aurora_synced_at = ${now}::timestamp
      FROM jsonb_to_recordset(${payload}::jsonb) AS u(
        climb_uuid text,
        angle integer,
        climbed_at text,
        attempt_count integer
      )
      WHERE t.user_id = ${userId}
        AND t.board_type = ${boardType}
        AND t.origin = 'json_import'
        AND t.aurora_type = 'ascents'
        AND t.status IN ('flash', 'send')
        AND t.climb_uuid = u.climb_uuid
        AND t.angle = u.angle
        AND t.climbed_at = u.climbed_at::timestamp
      RETURNING t.uuid
    `);

    // drizzle's execute() return shape differs by driver (postgres-js returns
    // the rows array; Neon HTTP wraps them in { rows }), so normalize both.
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    healed += rows.length;
  }

  return healed;
}

// ---------------------------------------------------------------------------
// Self-healing remediation for #3521
// ---------------------------------------------------------------------------

/** Natural key of an export record the user climbed mirrored. */
type MirroredTickKey = {
  climbUuid: string;
  angle: number;
  climbedAt: string;
};

/**
 * Set `is_mirror` on rows an earlier import wrote as non-mirrored because the
 * export's mirror field was being stripped before it ever reached the row
 * builder (#3521).
 *
 * A re-import can't fix those rows on its own: the cross-source dedup below
 * SKIPS a record whose natural key already exists, so the ON CONFLICT upsert
 * never runs for it. This UPDATE is the only channel that reaches them, and
 * re-importing the file is the obvious thing a user does to correct their
 * logbook. Same shape as the #3301 heal above: matched on the natural key
 * (climb_uuid, angle, climbed_at) of this user's own json_import rows,
 * in-place, never a delete and never a twin.
 *
 * Two guards the #3301 heal doesn't have:
 *  - Only ever flips false → true, and only from records the export marks
 *    mirrored. An export that carries no mirror field produces an empty key
 *    list and this never runs, so the change is inert on files that lack it.
 *  - Skips locally-edited rows (updated_at > aurora_synced_at), the same test
 *    the live pull uses, so a user who fixed the orientation by hand in
 *    Boardsesh doesn't get overwritten by a stale re-import.
 *
 * Returns the number of rows healed.
 */
async function healJsonImportMirrorFlags(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  boardType: BoardType,
  userId: string,
  keys: MirroredTickKey[],
  now: string,
): Promise<number> {
  if (keys.length === 0) return 0;

  let healed = 0;
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const payload = JSON.stringify(
      batch.map((key) => ({
        climb_uuid: key.climbUuid,
        angle: key.angle,
        climbed_at: key.climbedAt,
      })),
    );

    const result = await db.execute(sql`
      UPDATE boardsesh_ticks AS t SET
        is_mirror = true,
        updated_at = ${now}::timestamp,
        aurora_synced_at = ${now}::timestamp
      FROM jsonb_to_recordset(${payload}::jsonb) AS u(
        climb_uuid text,
        angle integer,
        climbed_at text
      )
      WHERE t.user_id = ${userId}
        AND t.board_type = ${boardType}
        AND t.origin = 'json_import'
        AND t.is_mirror IS DISTINCT FROM true
        AND (t.aurora_synced_at IS NULL OR t.updated_at <= t.aurora_synced_at)
        AND t.climb_uuid = u.climb_uuid
        AND t.angle = u.angle
        AND t.climbed_at = u.climbed_at::timestamp
      RETURNING t.uuid
    `);

    // drizzle's execute() return shape differs by driver (postgres-js returns
    // the rows array; Neon HTTP wraps them in { rows }), so normalize both.
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    healed += rows.length;
  }

  return healed;
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

    // For published climbs, skip creating a placeholder only when a REAL catalog
    // climb (user_id IS NULL) already covers the name ON THE SAME LAYOUT. Keying
    // by (layoutId, name) — not name alone — matters: a same-name catalog climb
    // on ANOTHER layout is a different climb, and letting it suppress this
    // layout's placeholder would leave the import's ascents with nothing to
    // resolve to. We also intentionally do NOT skip on another user's unlisted
    // placeholder (user_id set) — placeholders are per-user import artifacts, and
    // skipping there would leave this user's ascents unable to resolve to
    // anything (resolveClimbNames matches a foreign placeholder neither as
    // catalog nor as this user's own).
    const publishedNames = publishedClimbs.map((c) => c.name);
    const publishedLayoutIds = [
      ...new Set(
        publishedClimbs
          .map((climb) => resolveLayoutName(boardType, climb.layout))
          .filter((layoutId): layoutId is number => layoutId != null),
      ),
    ];
    const existingPublishedKeys = new Set<string>();
    if (publishedNames.length > 0 && publishedLayoutIds.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < publishedNames.length; i += chunkSize) {
        const chunk = publishedNames.slice(i, i + chunkSize);
        const existing = await db
          .select({ name: boardClimbs.name, layoutId: boardClimbs.layoutId })
          .from(boardClimbs)
          .where(
            and(
              eq(boardClimbs.boardType, boardType),
              inArray(boardClimbs.layoutId, publishedLayoutIds),
              inArray(boardClimbs.name, chunk),
              eq(boardClimbs.isDraft, false),
              isNull(boardClimbs.userId),
            ),
          );
        for (const row of existing) {
          if (row.name && row.layoutId != null) {
            existingPublishedKeys.add(publishedClimbKey(row.layoutId, row.name));
          }
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

      draftRows.push(
        buildImportedClimbRow({
          userId,
          boardType,
          layoutId,
          setterUsername: data.user.username,
          name: climb.name,
          description: climb.description,
          frames,
          edges,
          createdAt: climb.created_at,
          isDraft: true,
        }),
      );
    }

    // Build rows for published climbs that don't already exist
    const publishedRows: ClimbRow[] = [];
    for (const climb of publishedClimbs) {
      // Resolve the layout FIRST — the skip decision is per (layout, name).
      const layoutId = resolveLayoutName(boardType, climb.layout);
      if (layoutId == null) {
        result.climbs.failed++;
        continue;
      }

      if (existingPublishedKeys.has(publishedClimbKey(layoutId, climb.name))) {
        result.climbs.skipped++;
        continue;
      }

      const coordMap = buildCoordinateMap(boardType, layoutId);
      const frames = convertHoldsToFrames(climb.holds, coordMap, boardType);
      if (!frames) {
        result.climbs.failed++;
        continue;
      }

      const edges = computeEdgesFromHolds(climb.holds);

      // Published-but-uncatalogued climbs import UNLISTED (see buildImportedClimbRow):
      // per-user placeholders that anchor the importer's ticks without polluting
      // catalog search with a duplicate of the real climb.
      publishedRows.push(
        buildImportedClimbRow({
          userId,
          boardType,
          layoutId,
          setterUsername: data.user.username,
          name: climb.name,
          description: climb.description,
          frames,
          edges,
          createdAt: climb.created_at,
          isDraft: false,
        }),
      );
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
                characteristics: mergeCatalogCharacteristicsSql(
                  boardClimbs.characteristics,
                  sql`excluded.characteristics`,
                  [CLIMB_CHARACTERISTICS.NO_MATCH],
                ),
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

        // Insert published placeholders. On a uuid conflict — a placeholder this
        // same user imported before — flip the stored row to the current unlisted
        // policy instead of DO NOTHING, which would preserve is_listed=true
        // pollution from imports made before placeholders went unlisted. See
        // importedPlaceholderConflictPolicy for the scoping invariants.
        for (let i = 0; i < publishedRows.length; i += BATCH_SIZE) {
          const batch = publishedRows.slice(i, i + BATCH_SIZE);
          // Count actual insertions: rows whose uuid already exists are re-imports
          // (updated in place), reported as skipped rather than imported. The
          // SELECT+INSERT pair is not atomic, so these counts are approximate
          // under concurrent same-user imports; data integrity is unaffected
          // (the upsert itself is conflict-safe).
          const preExisting = await tx
            .select({ uuid: boardClimbs.uuid })
            .from(boardClimbs)
            .where(
              inArray(
                boardClimbs.uuid,
                batch.map((row) => row.uuid),
              ),
            );
          await tx
            .insert(boardClimbs)
            .values(batch)
            .onConflictDoUpdate({
              target: boardClimbs.uuid,
              ...importedPlaceholderConflictPolicy(userId),
            });
          result.climbs.imported += batch.length - preExisting.length;
          result.climbs.skipped += preExisting.length;
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

  // Split the `ascents` array into true sends and merged-shape attempts. The
  // live Aurora backend (Tension / TB2) delivers a unified logbook in `ascents`
  // and flags a never-sent bid with `is_ascent: false`; classifying purely by
  // array membership stamped every one as a send (#3301). A missing/true flag —
  // every legacy Kilter export — stays an ascent, so that path is unchanged.
  const trueAscents = data.ascents.filter((ascent) => !isExportAscentActuallyAttempt(ascent));
  const reclassifiedAttempts = data.ascents.filter(isExportAscentActuallyAttempt).map(exportAscentToAttempt);
  const allAttempts = [...data.attempts, ...reclassifiedAttempts];

  // Track unresolved names, split per-source so the UI can show each section
  // separately (an ascent with an unmatched climb is a different user story
  // from a circuit referencing an unmatched climb).
  const unresolvedAscentSet = new Set<string>();
  const unresolvedAttemptSet = new Set<string>();
  const unresolvedCircuitSet = new Set<string>();
  for (const ascent of trueAscents) {
    if (!nameToUuid.has(ascent.climb)) unresolvedAscentSet.add(ascent.climb);
  }
  for (const attempt of allAttempts) {
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

  // Natural keys of the merged-shape attempts, used to heal any send an earlier
  // (pre-#3301) import wrote for the same record (see self-heal below).
  const reclassifiedAttemptKeys: MislabeledAttemptKey[] = [];
  for (const attempt of reclassifiedAttempts) {
    const climbUuid = nameToUuid.get(attempt.climb);
    if (!climbUuid) continue;
    reclassifiedAttemptKeys.push({
      climbUuid,
      angle: attempt.angle,
      climbedAt: normalizeTimestamp(attempt.climbed_at),
      attemptCount: attempt.count,
    });
  }

  // Natural keys of every record the export marks mirrored, used to heal rows a
  // pre-#3521 import wrote non-mirrored (see self-heal below). Empty whenever
  // the export carries no mirror field, which makes the heal a no-op there.
  const mirroredTickKeys: MirroredTickKey[] = [];
  for (const record of [...trueAscents, ...allAttempts]) {
    if (!readExportBool(record.is_mirror)) continue;
    const climbUuid = nameToUuid.get(record.climb);
    if (!climbUuid) continue;
    mirroredTickKeys.push({
      climbUuid,
      angle: record.angle,
      climbedAt: normalizeTimestamp(record.climbed_at),
    });
  }

  // Step 5: Collect ascent rows to insert (in-memory dedup first)
  //
  // The dedup key deliberately omits mirror (#3521). Adding it would let a
  // mirrored and a non-mirrored record at the same (climb, angle, instant) both
  // pass — and since `generateJsonImportAuroraId` is frozen, both would carry
  // the SAME aurora_id and land in one INSERT … ON CONFLICT DO UPDATE batch,
  // which Postgres rejects outright (21000, "cannot affect row a second time"),
  // failing the whole chunk. Splitting that pair needs the id key to change
  // too, which is a migration, not a one-liner. So the pre-existing behaviour
  // stands: such a pair collapses to one row (the first one wins, the second is
  // counted as skipped). It needs two logs of the same climb at the same angle
  // in the same second, which Aurora's second-resolution climbed_at makes very
  // rare, and the outcome is a skip, not corruption.
  const ascentRows = trueAscents.reduce<JsonImportTickRow[]>((rows, ascent) => {
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
    rows.push(buildJsonImportAscentTickRow(userId, boardType, ascent, climbUuid, climbedAt, now));
    return rows;
  }, []);

  // Step 6: Collect attempt rows to insert (both native `attempts` and any
  // merged-shape `is_ascent: false` records pulled out of `ascents` above).
  const attemptRows = allAttempts.reduce<JsonImportTickRow[]>((rows, attempt) => {
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
      isMirror: readExportBool(attempt.is_mirror),
      status: 'attempt',
      attemptCount: attempt.count,
      quality: null,
      difficulty: null,
      isBenchmark: false,
      comment: '',
      climbedAt,
      createdAt: attempt.created_at ? normalizeTimestamp(attempt.created_at) : now,
      updatedAt: now,
      origin: 'json_import' as const,
      auroraType: 'bids' as const,
      auroraId: generateJsonImportAuroraId(userId, climbUuid, attempt.angle, climbedAt, 'bids'),
      auroraSyncedAt: now,
    });
    return rows;
  }, []);

  // Step 7: Batch-insert ascents and attempts, plus self-heal any pre-#3301
  // mislabeled sends and pre-#3521 dropped mirror flags, all in one transaction.
  let healedMislabeledSends = 0;
  let healedMirrorFlags = 0;
  await db.transaction(async (tx) => {
    result.ascents.imported = await batchInsertTicks(
      tx,
      ascentRows,
      // `origin` is intentionally absent from both conflict sets below: it
      // records where the row was FIRST created, so a native tick matched by a
      // later re-import keeps origin='native' (else the recompute would stop
      // counting it).
      {
        climbUuid: sql`excluded.climb_uuid`,
        angle: sql`excluded.angle`,
        status: sql`excluded.status`,
        attemptCount: sql`excluded.attempt_count`,
        quality: sql`excluded.quality`,
        difficulty: sql`excluded.difficulty`,
        // #3521: a row reached by the upsert (rather than skipped by the dedup)
        // takes the export's orientation too, instead of keeping a stale false.
        isMirror: sql`excluded.is_mirror`,
        climbedAt: sql`excluded.climbed_at`,
        updatedAt: sql`excluded.updated_at`,
        auroraSyncedAt: sql`excluded.aurora_synced_at`,
      },
      'ascents',
      trueAscents.length,
      onProgress,
    );

    result.attempts.imported = await batchInsertTicks(
      tx,
      attemptRows,
      {
        climbUuid: sql`excluded.climb_uuid`,
        angle: sql`excluded.angle`,
        attemptCount: sql`excluded.attempt_count`,
        isMirror: sql`excluded.is_mirror`,
        climbedAt: sql`excluded.climbed_at`,
        updatedAt: sql`excluded.updated_at`,
        auroraSyncedAt: sql`excluded.aurora_synced_at`,
      },
      'attempts',
      allAttempts.length,
      onProgress,
    );

    // Remediation (#3301): flip any send a prior buggy import wrote for a record
    // that is now correctly classified as an attempt. The dedup above already
    // skips inserting a twin for these keys, so this UPDATE is what actually
    // corrects the stale row. Never deletes.
    healedMislabeledSends = await healMislabeledJsonImportAttempts(tx, boardType, userId, reclassifiedAttemptKeys, now);

    // Remediation (#3521): set is_mirror on rows a pre-fix import wrote
    // non-mirrored. Same reason as above — the dedup skips these keys, so the
    // upsert never reaches them and this UPDATE is the only correction channel.
    healedMirrorFlags = await healJsonImportMirrorFlags(tx, boardType, userId, mirroredTickKeys, now);
  });

  // Structured breadcrumb (info-level, not an error) so we can measure how often
  // the merged-shape Aurora export path actually fires in prod — and confirm the
  // #3301 discriminator assumption against real Tension/TB2 imports. Uses
  // console (with key=value fields) rather than the backend winston logger on
  // purpose: this shared package must not depend on `packages/backend`, and it
  // already logs via console elsewhere. The backend captures stdout regardless.
  // Counterpart breadcrumb for #3521. Whether Aurora's account export carries a
  // mirror field at all was unverified when this shipped — no real export was
  // available to check — so this is how prod answers it: a non-zero
  // mirroredRecords on a real import confirms the field exists and is named
  // `is_mirror`. Counts only, no user content.
  if (mirroredTickKeys.length > 0 || healedMirrorFlags > 0) {
    console.info(
      `[aurora-import][3521] mirrored records: boardType=${boardType} mirroredRecords=${mirroredTickKeys.length} healedMirrorFlags=${healedMirrorFlags}`,
    );
  }

  if (reclassifiedAttempts.length > 0 || healedMislabeledSends > 0) {
    console.info(
      `[aurora-import][3301] merged-shape logbook: boardType=${boardType} reclassifiedAttempts=${reclassifiedAttempts.length} healedMislabeledSends=${healedMislabeledSends}`,
    );
  }

  // Fold this chunk's imported ascents into board_climb_stats. json_import
  // ticks don't add to the Boardsesh count (they're already upstream), but the
  // recompute keeps the materialized row consistent and demotes any stale
  // Boardsesh crown. Distinct (climb, angle) keys of the ascents we wrote.
  const importedAscentKeys = new Map<string, ClimbStatsKey>();
  for (const row of ascentRows) {
    importedAscentKeys.set(`${row.climbUuid} ${row.angle}`, {
      boardType,
      climbUuid: row.climbUuid,
      angle: row.angle,
    });
  }
  // A self-heal flips a send → attempt, which drops an ascent from that
  // (climb, angle) — recompute those keys too so the ascensionist count and any
  // stale Boardsesh crown follow the correction.
  for (const key of reclassifiedAttemptKeys) {
    importedAscentKeys.set(`${key.climbUuid} ${key.angle}`, {
      boardType,
      climbUuid: key.climbUuid,
      angle: key.angle,
    });
  }
  const importedAscentKeyList = [...importedAscentKeys.values()];
  await recomputeClimbStatsBulk(db, importedAscentKeyList);

  // Step 8: Import circuits as playlists (separate transaction per circuit
  // so one failure doesn't roll back others or abort the tick transaction)
  for (let ci = 0; ci < data.circuits.length; ci++) {
    const circuit = data.circuits[ci];
    const resolvedClimbs = resolveCircuitClimbUuids(circuit.climbs, nameToUuid);

    // The key is user-scoped (see generateJsonImportCircuitAuroraId), so two
    // importers can no longer collide on the global `playlists_aurora_id_idx`.
    // The ownership guard below is defence in depth for the same class of bug
    // (#3526) — cheap, and the only thing standing between a future
    // key-derivation change and a silent re-run of the 2026-03 incident.
    const circuitAuroraId = generateJsonImportCircuitAuroraId(userId, boardType, circuit.name, circuit.created_at);
    const formattedColor = normalizePlaylistColor(circuit.color);
    const circuitNow = new Date();

    try {
      const outcome = await db.transaction(async (tx): Promise<'imported' | 'refused'> => {
        const owners = await tx
          .select({ ownerUserId: playlistOwnership.userId })
          .from(playlists)
          .innerJoin(
            playlistOwnership,
            and(eq(playlistOwnership.playlistId, playlists.id), eq(playlistOwnership.role, 'owner')),
          )
          .where(eq(playlists.auroraId, circuitAuroraId));

        const decision = resolveUpstreamPlaylistWrite(
          owners.map((row) => row.ownerUserId),
          userId,
        );
        if (!canWriteUpstreamPlaylist(decision)) {
          console.warn(
            upstreamPlaylistSkipLogLine({
              syncTag: 'aurora-import',
              upstreamIdColumn: 'aurora_id',
              upstreamId: circuitAuroraId,
              syncingUserId: userId,
              decision,
            }),
          );
          // Not a throw: a refusal is an expected outcome, not an import
          // failure, and the transaction has only read so far — there is
          // nothing to roll back.
          return 'refused';
        }

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
            // SQL-level twin of the decision gate above — see the identical
            // guard on the aurora user-sync circuits upsert.
            setWhere: foreignPlaylistOwnerGuard(userId),
          })
          .returning({ id: playlists.id });

        // Empty when the ON CONFLICT guard suppressed the DO UPDATE (a
        // concurrent claim won the race). Same outcome as the decision gate
        // above, so it lands in the same bucket.
        if (!playlist) return 'refused';

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
            // Belt to the dedupe's braces: a re-import racing a concurrent
            // addClimbToPlaylist can still land a row between the delete and
            // this insert, and DO NOTHING keeps that one instead of aborting
            // the circuit. #4023.
            await tx
              .insert(playlistClimbs)
              .values(climbValues.slice(i, i + BATCH_SIZE))
              .onConflictDoNothing({ target: [playlistClimbs.playlistId, playlistClimbs.climbUuid] });
          }
        }

        return 'imported';
      });
      // `skipped`, not `failed`: a refusal is a deliberate decision, already
      // logged with full context by the guard. Telling the climber their import
      // FAILED when we chose not to overwrite someone else's playlist would be
      // wrong, and the UI renders all three counts.
      if (outcome === 'refused') {
        result.circuits.skipped++;
      } else {
        result.circuits.imported++;
      }
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
      await correctFlashStatusForUser(db, userId, boardType);
      // correctFlashStatusForUser only flips flash<->send (both ascents), so it
      // never changes the ascensionist count — but re-run the recompute for this
      // import's keys so FA/first-ascent derivation reflects the final statuses.
      // (No-op when the import had no ascents: the bulk helper early-returns on
      // an empty key list.)
      await recomputeClimbStatsBulk(db, importedAscentKeyList);
    } catch (error) {
      console.error('Error correcting flash status after JSON import:', error);
      const msg = error instanceof Error ? error.message : 'Flash status correction failed';
      result.partialError = result.partialError ? `${result.partialError}\n${msg}` : msg;
    }
  }

  return result;
}
