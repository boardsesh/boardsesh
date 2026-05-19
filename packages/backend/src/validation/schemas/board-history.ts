import { z } from 'zod';
import { SessionIdSchema } from './primitives';

/**
 * Input validation for `recordBoardSend`.
 *
 * - `uuid` is the client-generated idempotency key (server does
 *   ON CONFLICT (uuid) DO NOTHING).
 * - `boardSerial` is the canonical room/log key.
 * - `boardId` is best-effort — null when the user hasn't registered the
 *   controller as a saved userBoards row.
 * - `source` mirrors the `board_history_source` enum in the DB schema; the
 *   GraphQL enum uppercases the values, but resolvers normalise to lower
 *   case before the zod parse so this schema sees the DB-side strings.
 */
export const RecordBoardSendInputSchema = z.object({
  uuid: z.string().uuid('Invalid uuid'),
  boardSerial: z.string().min(1, 'boardSerial required').max(128, 'boardSerial too long'),
  boardId: z.number().int().positive().nullish(),
  climbUuid: z.string().min(1, 'climbUuid required').max(128, 'climbUuid too long'),
  angle: z.number().int().min(0, 'angle >= 0').max(90, 'angle <= 90'),
  isMirror: z.boolean().optional().default(false),
  frames: z.string().max(8192, 'frames too long').nullish(),
  source: z.enum(['ble_send', 'manual', 'shared_queue_relay']),
  sessionId: z.string().min(1).max(128).nullish(),
  sharedPlaylistMode: z.boolean(),
});

export type RecordBoardSendInputParsed = z.infer<typeof RecordBoardSendInputSchema>;

/**
 * Input validation for `setSharedPlaylistEnabled`. Reuses the standard session
 * ID format (alphanumeric + hyphens, capped at 100 chars).
 */
export const SetSharedPlaylistEnabledInputSchema = z.object({
  sessionId: SessionIdSchema,
  enabled: z.boolean(),
});

export type SetSharedPlaylistEnabledInputParsed = z.infer<typeof SetSharedPlaylistEnabledInputSchema>;

/**
 * Validation for the boardHistory query / subscription params.
 *
 * Uses a local, looser serial schema rather than the BLE-parser-tight
 * `BoardSerialSchema` from `./primitives`. The board-history room key is
 * forwarded verbatim from client requests (subscribe / query) and is allowed
 * to be any non-empty short string; the canonical BLE-parsed serials get
 * validated separately at the parse boundary.
 */
export const BoardHistorySerialSchema = z.string().min(1, 'boardSerial required').max(128, 'boardSerial too long');

export const BoardHistoryQueryInputSchema = z.object({
  boardSerial: BoardHistorySerialSchema,
  limit: z.number().int().min(1).max(200).optional(),
  // ISO 8601 cursor; resolvers parse to Date.
  before: z.string().datetime({ offset: true }).optional(),
});
