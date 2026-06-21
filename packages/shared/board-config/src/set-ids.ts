/**
 * Parse a comma-separated set_ids string into a number[]. Accepts an array
 * directly (passthrough) so call sites that already have the normalised form
 * can share this helper.
 */
export function parseSetIds(setIds: string | number[]): number[] {
  if (Array.isArray(setIds)) return setIds;
  return setIds
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0) // drop empty tokens ('', trailing/double commas) so '' → [] not [0]
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value));
}

/**
 * Normalise a comma-separated set_ids string to a deduped, numerically-sorted
 * representation so order/whitespace differences don't trigger spurious
 * mismatches. Sorts numerically (not lexicographically) so multi-digit ids
 * compare the same way the write-path emits them: ["10","2"] → "2,10".
 */
export function normaliseSetIds(setIds: string): string {
  return [
    ...new Set(
      setIds
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  ]
    .sort((first, second) => Number(first) - Number(second))
    .join(',');
}
