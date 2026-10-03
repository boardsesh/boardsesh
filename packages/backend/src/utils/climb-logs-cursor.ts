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
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
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
  if (typeof climbedAt !== 'string' || !TIMESTAMP_PATTERN.test(climbedAt)) return null;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;

  const parsedId = BigInt(id);
  if (parsedId > MAX_BIGINT_ID) return null;
  return { climbedAt, id: parsedId };
}
