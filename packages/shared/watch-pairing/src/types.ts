/** A short-lived code the user types on their Garmin watch to link it to their account. */
export type WatchPairingCode = {
  /** The short code shown to the user. */
  code: string;
  /** ISO-8601 timestamp after which the code stops working. */
  expiresAt: string;
};

/**
 * Narrow an unknown pair-code response to a {@link WatchPairingCode}. Guards the
 * fetch boundary on both web and mobile so a malformed backend payload throws at
 * the seam instead of leaking `undefined` into the countdown / display.
 */
export function isWatchPairingCode(value: unknown): value is WatchPairingCode {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === 'string' && typeof candidate.expiresAt === 'string';
}
