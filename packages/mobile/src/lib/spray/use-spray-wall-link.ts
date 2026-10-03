// Validate the `?wall=<uuid>` capability before the board-route handoff redeems it.
// The handoff awaits server authorization and binds the result to the URL slug.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a search param is shaped like the uuid a share link carries. */
export function isWallUuidParam(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
