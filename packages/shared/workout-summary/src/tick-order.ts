// The one order both readers walk a session's ticks in, so the server's
// derivation and every client's grouping see the same sequence.

const toMillis = (climbedAt: string | Date): number => {
  const millis = climbedAt instanceof Date ? climbedAt.getTime() : Date.parse(climbedAt);
  return Number.isNaN(millis) ? 0 : millis;
};

/**
 * `ticks` oldest first, as a new array: by `climbedAt`, then by `uuid`, then
 * in input order. The uuid settles equal times, which the tick queries return
 * in no fixed order, so the phone and the server place them the same way; the
 * input order only settles a uuid listed twice.
 */
export function ticksInTimeOrder<Tick extends { uuid: string; climbedAt: string | Date }>(
  ticks: ReadonlyArray<Tick>,
): Tick[] {
  return ticks
    .map((tick, index) => ({ tick, index, millis: toMillis(tick.climbedAt) }))
    .sort(
      (left, right) =>
        left.millis - right.millis ||
        (left.tick.uuid < right.tick.uuid ? -1 : left.tick.uuid > right.tick.uuid ? 1 : 0) ||
        left.index - right.index,
    )
    .map(({ tick }) => tick);
}
