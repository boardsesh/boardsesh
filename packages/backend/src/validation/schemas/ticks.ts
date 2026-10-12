import { PrivacyPublicationInputSchema } from './privacy-publication';
import { z } from 'zod';
import { BETA_VIDEO_URL_REGEX, BETA_VIDEO_URL_VALIDATION_MESSAGE } from '@boardsesh/shared-schema';
import { ExternalUUIDSchema, BoardNameSchema, UUIDSchema } from './primitives';
import { BOARD_ANGLE_VALIDATION_MESSAGE, isBoardAngleSupported } from './board-angles';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';

// Bounds of the Aurora difficulty scale, derived from the shared grade table so
// they cannot drift from it. `difficulty` used to be an unbounded int, which was
// harmless while it was only ever displayed — but a personal grade now drives
// the grade filter and the difficulty sort (#4796, #4828), so an out-of-range
// value would put a climb outside every grade bucket the UI can select.
const MIN_DIFFICULTY_ID = BOULDER_GRADES[0].difficulty_id;
const MAX_DIFFICULTY_ID = BOULDER_GRADES[BOULDER_GRADES.length - 1].difficulty_id;

const CLIMBED_AT_FUTURE_TOLERANCE_MS = 60_000;

/**
 * Fractional seconds of a client timestamp, capture group 1.
 *
 * The trailing zone alternatives cover every shape `new Date()` accepts
 * alongside a fraction: bare, `Z`, and a `+hh` / `+hhmm` / `+hh:mm` offset that
 * a space may precede. Missing one of those would let a timestamp through with
 * its fraction unread — the precision refine below would pass vacuously and
 * `normalizeClimbedAt` would store `.000`, so validator and normalizer share
 * this one pattern rather than each keeping a copy.
 */
export const POSTGRES_TIMESTAMP_FRACTION_PATTERN = /[Tt ]\d{2}:\d{2}:\d{2}\.(\d+)\s*(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?$/;

export function readTimestampFractionalSeconds(value: string): string | undefined {
  return POSTGRES_TIMESTAMP_FRACTION_PATTERN.exec(value)?.[1];
}

function hasSupportedPostgresTimestampPrecision(value: string): boolean {
  const fractionalSeconds = readTimestampFractionalSeconds(value);
  return fractionalSeconds === undefined || fractionalSeconds.length <= 6;
}

/**
 * Tick status validation schema
 */
export const TickStatusSchema = z.enum(['flash', 'send', 'attempt'], {
  error: 'Status must be flash, send, or attempt',
});

/**
 * Save tick input validation schema
 */
export const SaveTickInputSchema = z
  .object({
    privacy: PrivacyPublicationInputSchema.optional(),
    uuid: z.string().uuid('Invalid UUID format').optional(),
    boardType: BoardNameSchema,
    climbUuid: ExternalUUIDSchema,
    // Accepted and ignored. Climb revisions were retired (#6023, #6180), and a
    // new tick stores no revision. The field stays because app bundles from
    // before the retirement, and sends already queued in their offline outboxes,
    // still carry it: an unknown input field fails the request, and a send that
    // fails for good dead-letters in the drainer. `.catch(null)` for the same
    // reason: 0 or a negative number must not fail the tick either.
    climbRevision: z.number().int().positive().optional().nullable().catch(null),
    angle: z.number().int().min(-5).max(90),
    isMirror: z.boolean(),
    status: TickStatusSchema,
    attemptCount: z.number().int().min(1).max(999),
    quality: z.number().int().min(1).max(5).optional().nullable(),
    difficulty: z.number().int().min(MIN_DIFFICULTY_ID).max(MAX_DIFFICULTY_ID).optional().nullable(),
    isBenchmark: z.boolean(),
    comment: z.string().max(2000),
    climbedAt: z
      .string()
      .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Climbed at must be a valid date')
      .refine(hasSupportedPostgresTimestampPrecision, 'Climbed at supports at most six fractional-second digits'),
    sessionId: z.string().optional(),
    layoutId: z.number().int().positive().optional(),
    sizeId: z.number().int().positive().optional(),
    setIds: z.string().min(1).optional(),
    boardUuid: UUIDSchema.optional(),
    boardId: z.number().int().positive().optional().nullable(),
    videoUrl: z.string().max(500).regex(BETA_VIDEO_URL_REGEX, BETA_VIDEO_URL_VALIDATION_MESSAGE).optional().nullable(),
  })
  .refine((data) => isBoardAngleSupported(data.boardType, data.angle), {
    message: BOARD_ANGLE_VALIDATION_MESSAGE,
    path: ['angle'],
  })
  .refine(
    (data) => {
      // A flash is by definition a first-try ascent, so attemptCount must be 1.
      // A send is any successful ascent — the attempt count on the row just
      // records how many tries that particular log represents (e.g. 1 when the
      // user is logging a single successful action, >1 when they're
      // back-filling a redpoint that took multiple tries). Both are valid.
      if (data.status === 'flash' && data.attemptCount !== 1) return false;
      return true;
    },
    { message: 'Flash requires attemptCount of 1', path: ['attemptCount'] },
  );

/**
 * Get ticks input validation schema
 */
export const GetTicksInputSchema = z.object({
  boardType: BoardNameSchema,
  climbUuids: z.array(ExternalUUIDSchema).optional(),
});

/**
 * Attach beta link input validation schema
 */
export const AttachBetaLinkInputSchema = z
  .object({
    privacy: PrivacyPublicationInputSchema.optional(),
    boardType: BoardNameSchema,
    climbUuid: ExternalUUIDSchema,
    link: z.string().max(500).regex(BETA_VIDEO_URL_REGEX, BETA_VIDEO_URL_VALIDATION_MESSAGE),
    // When tickUuid is provided the stored angle comes from the resolved tick,
    // not from this field. Clients may omit angle in that case. If both are
    // supplied and disagree, the resolver throws BETA_LINK_TICK_MISMATCH.
    angle: z.number().int().min(-5).max(90).optional().nullable(),
    tickUuid: UUIDSchema.optional().nullable(),
  })
  .refine((data) => isBoardAngleSupported(data.boardType, data.angle), {
    message: BOARD_ANGLE_VALIDATION_MESSAGE,
    path: ['angle'],
  });

/**
 * instagramBetaScan input validation schema.
 *
 * A scraped-post payload fed to the beta-import scanner. `boardType` is the
 * default board for posts whose caption doesn't name one; the per-post caption
 * can still override it (see parseInstagramBetaCaption). Posts are capped at
 * 2000 — well above a single account's realistic beta backlog, low enough to
 * bound the per-call resolution + dedup work.
 */
export const InstagramScanPostInputSchema = z.object({
  shortcode: z.string().min(1, 'Shortcode cannot be empty').max(100, 'Shortcode too long'),
  caption: z.string().max(5000).optional().nullable(),
  takenAt: z.string().max(100).optional().nullable(),
});

export const InstagramBetaScanInputSchema = z.object({
  // Scoped to the boards whose share captions use the quoted `"name" @ angle°`
  // format the parser understands and that the import UI offers. Other boards
  // (e.g. MoonBoard's comma format) are rejected rather than silently
  // zero-matching.
  boardType: z.enum(['kilter', 'tension']),
  posts: z.array(InstagramScanPostInputSchema).max(2000, 'Too many posts in a single scan'),
});

/**
 * Ascent feed input validation schema
 */
// Logbook date filters are calendar days (YYYY-MM-DD) or exact instants. The
// web/mobile clients sanitize to these shapes via @boardsesh/logbook, but the
// backend owns its own invariant so a direct GraphQL call can't push a malformed
// date into the query.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Postgres has no year 0 and no zone displacement past ±15:59. Both would reach
// it as an internal "out of range" error, so they are refused here instead.
const DATE_BOUND_YEAR_MESSAGE = 'Date bounds start at year 0001';
const MAX_OFFSET_HOURS = 15;

function isAfterYearZero(value: string): boolean {
  return !value.startsWith('0000');
}

// z.iso.datetime has already pinned the offset to `Z` or `±HH:MM`.
function hasSupportedPostgresOffset(value: string): boolean {
  const offset = /[+-](\d{2}):\d{2}$/.exec(value);
  return offset === null || Number(offset[1]) <= MAX_OFFSET_HOURS;
}

/**
 * A logbook date bound. A calendar day is that whole UTC day, the contract
 * older clients rely on. An instant must carry `Z` or an offset: it is the edge
 * of the climber's local day, which only the client knows. A zone-less
 * date-time is refused, because the server would have to guess the zone.
 */
const LogbookDateBoundSchema = z.union([
  // z.iso.date checks the calendar too (no 2026-13-45, no 2026-02-30).
  z.iso.date().refine(isAfterYearZero, DATE_BOUND_YEAR_MESSAGE),
  z.iso
    .datetime({ offset: true })
    .refine(isAfterYearZero, DATE_BOUND_YEAR_MESSAGE)
    .refine(hasSupportedPostgresTimestampPrecision, 'Date bounds support at most six fractional-second digits')
    .refine(hasSupportedPostgresOffset, 'Time zone offsets run from -15:59 to +15:59'),
]);

/** True for the calendar-day form of a logbook date bound (YYYY-MM-DD). */
export function isCalendarDayBound(value: string): boolean {
  return ISO_DATE_PATTERN.test(value);
}

// Setter filter bounds, shared by the feed filter and the setter picker search.
const SETTER_USERNAME_MAX_LENGTH = 100;
const MAX_SETTER_FILTER_ENTRIES = 20;
const SetterUsernameSchema = z.string().min(1).max(SETTER_USERNAME_MAX_LENGTH);

export const AscentFeedInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  boardType: BoardNameSchema.optional(),
  boardTypes: z.array(BoardNameSchema).optional(),
  layoutIds: z.array(z.number().int().positive()).optional(),
  status: z.enum(['flash', 'send', 'attempt']).optional(),
  statusMode: z.enum(['both', 'send', 'attempt']).optional(),
  flashOnly: z.boolean().optional(),
  climbName: z.string().max(200).optional(),
  sortBy: z
    .enum([
      'recent',
      'hardest',
      'easiest',
      'mostAttempts',
      'climbName',
      'loggedGrade',
      'consensusGrade',
      'date',
      'attemptCount',
    ])
    .optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  secondarySortBy: z.enum(['climbName', 'loggedGrade', 'consensusGrade', 'date', 'attemptCount']).optional(),
  secondarySortOrder: z.enum(['asc', 'desc']).optional(),
  minDifficulty: z.number().int().min(0).optional(),
  maxDifficulty: z.number().int().min(0).optional(),
  minAngle: z.number().int().min(-5).max(90).optional(),
  maxAngle: z.number().int().min(-5).max(90).optional(),
  benchmarkOnly: z.boolean().optional(),
  // Stars the logbook row shows: the tick's own, else the climber's synced rating.
  minQuality: z.number().int().min(1).max(5).optional(),
  // Exact setter usernames. Capped so one request can't build a huge IN list.
  setterUsernames: z.array(SetterUsernameSchema).max(MAX_SETTER_FILTER_ENTRIES).optional(),
  fromDate: LogbookDateBoundSchema.optional(),
  toDate: LogbookDateBoundSchema.optional(),
});

/**
 * userLoggedSetters input: the same board scope as the logbook feed, plus a
 * setter-name search for the picker.
 */
export const UserLoggedSettersInputSchema = z.object({
  boardTypes: z.array(BoardNameSchema).optional(),
  layoutIds: z.array(z.number().int().positive()).optional(),
  search: z.string().trim().max(SETTER_USERNAME_MAX_LENGTH).optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
});

/**
 * Update tick input validation schema
 */
export const UpdateTickInputSchema = z
  .object({
    privacy: PrivacyPublicationInputSchema.optional(),
    boardUuid: UUIDSchema.nullable().optional(),
    status: z.enum(['flash', 'send', 'attempt']).optional(),
    attemptCount: z.number().int().min(1).max(999).optional(),
    quality: z.number().int().min(1).max(5).optional().nullable(),
    difficulty: z.number().int().min(MIN_DIFFICULTY_ID).max(MAX_DIFFICULTY_ID).optional().nullable(),
    isBenchmark: z.boolean().optional(),
    comment: z.string().max(2000).optional(),
    climbedAt: z
      .string()
      .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Climbed at must be a valid date')
      .refine(hasSupportedPostgresTimestampPrecision, 'Climbed at supports at most six fractional-second digits')
      .refine(
        (value) => new Date(value).getTime() <= Date.now() + CLIMBED_AT_FUTURE_TOLERANCE_MS,
        'Climbed at cannot be in the future',
      )
      .optional(),
    // The board type comes from the stored tick, so the resolver performs the
    // board-aware check after lookup.
    angle: z.number().int().min(-5).max(90).optional(),
  })
  .refine(
    (data) => {
      if (data.status === 'flash' && data.attemptCount !== undefined && data.attemptCount !== 1) return false;
      return true;
    },
    { message: 'Flash requires attemptCount of 1', path: ['attemptCount'] },
  );
