/**
 * Per-user access control for the kilter-sync rollout.
 *
 * V1 is gated behind a server-side allowlist env var,
 * `KILTER_SYNC_ALLOWED_USER_IDS` — comma-separated NextAuth user IDs.
 * Empty / unset means the feature is off for everyone. This keeps the
 * rollout simple (no new infra, no feature-flag service) until we're
 * confident enough in the daemon + push-back path to flip it on by
 * default. PR 15 removes the gate.
 *
 * The allowlist is cached at module load so we don't reparse the env
 * var on every request. Next.js server modules are long-lived; if the
 * env var changes we need a redeploy, same as any other env-var-driven
 * feature flag in this codebase.
 */

let cached: Set<string> | null = null;

function getAllowlist(): Set<string> {
  if (cached === null) {
    const raw = process.env.KILTER_SYNC_ALLOWED_USER_IDS ?? '';
    cached = new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }
  return cached;
}

/**
 * Exposed for tests — drop the cached value so the next call re-reads
 * the env var.
 *
 * Guarded against accidental production invocation: in NODE_ENV=production
 * this is a no-op rather than a silent cache wipe. A spurious call in
 * prod (someone imports it from app code, an automated tool fires a
 * function reference, …) would otherwise reset the allowlist to whatever
 * the current env var holds — which could be empty if the env var was
 * rolled forward without a process restart. No-op-in-prod keeps the
 * test-only contract honest.
 */
export function resetKilterSyncAllowlistCacheForTests(): void {
  if (process.env.NODE_ENV === 'production') return;
  cached = null;
}

/**
 * Returns true when the calling user is on the allowlist. Async so we can
 * swap to a DB-backed feature-flag without changing call sites.
 */
export async function isKilterSyncAllowed(userId: string): Promise<boolean> {
  return getAllowlist().has(userId);
}

/**
 * Used by server components (and the settings UI bootstrap) to decide
 * whether to render the Kilter Connect button at all.
 */
export async function isKilterSyncAllowedForCurrentUser(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  return isKilterSyncAllowed(userId);
}
