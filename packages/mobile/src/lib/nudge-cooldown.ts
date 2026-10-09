/** Shared elapsed-time rule; rendering a card does not acknowledge it. */
export function hasNudgeCooldownElapsed(
  nowMs: number,
  lastAcknowledgedAtMs: number | null,
  cooldownMs: number,
): boolean {
  return lastAcknowledgedAtMs === null || nowMs - lastAcknowledgedAtMs >= cooldownMs;
}
