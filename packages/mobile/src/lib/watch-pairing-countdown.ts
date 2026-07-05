/**
 * Whole seconds left until `expiresAt`, clamped to 0 (never negative). Kept in its
 * own dependency-free module so the countdown tick and its "expired" transition are
 * unit-testable without pulling the React Native / auth chain in `watch-pairing.ts`.
 * Returns 0 for an unparseable timestamp so the UI fails safe to the expired state.
 */
export function remainingSeconds(expiresAt: string, now: number = Date.now()): number {
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) return 0;
  return Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
}
