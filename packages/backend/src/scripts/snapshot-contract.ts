// The publisher rejects an old primary cutoff and the watchdog independently
// verifies the same proof in the published heartbeat. Keep their default in one
// module so a release cannot silently weaken only one side of that contract.
export const DEFAULT_SNAPSHOT_MAX_CUTOFF_AGE_SECONDS = 10 * 60;
