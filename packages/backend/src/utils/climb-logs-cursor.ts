/**
 * Keyset cursor for `climbLogs`: the `(climbed_at, id)` of the last row on the
 * page before.
 *
 * `climbed_at` is a timezone-less timestamp read as a string, so the cursor
 * carries that string VERBATIM. Parsing it into a `Date` and back would shift
 * it by the server's offset and skip or repeat rows. `id` is a bigserial and
 * travels as a decimal string so it survives past 2^53.
 *
 * The decoder is strict because both values end up in a WHERE clause: anything
 * that is not exactly a timestamp and a positive integer decodes to null, and
 * the resolver turns null into BAD_USER_INPUT.
 */

type ClimbLogsCursorPayload = {
  /** Cursor format version */
  v: 1;
  /** boardsesh_ticks.climbed_at, as stored */
  t: string;
  /** boardsesh_ticks.id, decimal */
  i: string;
};

export type ClimbLogsCursor = { climbedAt: string; id: bigint };

/** What a `timestamp` column reads back as. */
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?$/;

/**
 * True for a string in the timestamp shape that also names a real instant. The
 * shape alone lets `2026-99-99 99:99:99` through, and Postgres then rejects the
 * cast: a broken cursor would surface as a database error instead of
 * BAD_USER_INPUT. Checked by building the date in UTC and reading the fields
 * back, with no timezone conversion of the cursor's own string.
 */
function isRealTimestamp(value: string): boolean {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
/** A bigint fits in 19 decimal digits. */
const ID_PATTERN = /^\d{1,19}$/;
const MAX_BIGINT_ID = 9223372036854775807n;

export function encodeClimbLogsCursor({ climbedAt, id }: ClimbLogsCursor): string {
  const payload: ClimbLogsCursorPayload = { v: 1, t: climbedAt, i: id.toString() };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeClimbLogsCursor(cursor: string): ClimbLogsCursor | null {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;

  const { v: version, t: climbedAt, i: id } = payload as Record<string, unknown>;
  if (version !== 1) return null;
  if (typeof climbedAt !== 'string' || !isRealTimestamp(climbedAt)) return null;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;

  const parsedId = BigInt(id);
  if (parsedId > MAX_BIGINT_ID) return null;
  return { climbedAt, id: parsedId };
}
