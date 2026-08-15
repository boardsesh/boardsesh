// Per-auth-session cache for the active-board tombstone validation. Keep this
// state separate from the active-board write coordinator: auth transitions must
// invalidate validation results without resetting or bypassing queued storage
// generations.

const initiallyValidatedUuids = new Set<string>();
let validationCacheEpoch = 0;

export function hasInitiallyValidatedActiveBoardUuid(boardUuid: string): boolean {
  return initiallyValidatedUuids.has(boardUuid);
}

export function captureActiveBoardSelfHealValidationEpoch(): number {
  return validationCacheEpoch;
}

export function isActiveBoardSelfHealValidationEpochCurrent(expectedEpoch: number): boolean {
  return expectedEpoch === validationCacheEpoch;
}

export function markInitiallyValidatedActiveBoardUuid(boardUuid: string, expectedEpoch: number): void {
  // A validation started for the previous account may finish after sign-out.
  // Never let that stale completion repopulate the next account's cache.
  if (!isActiveBoardSelfHealValidationEpochCurrent(expectedEpoch)) return;
  initiallyValidatedUuids.add(boardUuid);
}

/**
 * Reset only the self-heal validation cache at an authenticated-account
 * boundary. Active-board storage writes keep their independent generation and
 * queue semantics.
 */
export function resetActiveBoardSelfHealValidationCache(): void {
  validationCacheEpoch += 1;
  initiallyValidatedUuids.clear();
}
