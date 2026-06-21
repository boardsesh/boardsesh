// Decides what the optimistic favorite override should roll back to after a
// failed toggle. Returns `previous` only when `current` is still the optimistic
// value this toggle set — otherwise a newer tap / climb change owns the state
// and we leave it untouched.
export function resolveFavoriteRollback(
  current: boolean | null,
  optimistic: boolean,
  previous: boolean | null,
): boolean | null {
  return current === optimistic ? previous : current;
}
