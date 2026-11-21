/**
 * Code gates on `auth-authority activate`. Neither an environment variable nor an
 * operator flag closes one. `enforced` is database state an administrator could
 * set by hand, so the identity mirror's startup and the identity import check
 * these again rather than taking the phase as proof they closed.
 *
 * Closed, with the evidence that closed them:
 * - NATIVE_REVOKE_RESET_LOCK_ORDER: native sign-out and staged reset both take
 *   the shared gate, then the users row, before any other row of that climber
 *   (native-revoke-reset-lock-order.test.ts races them in both orders).
 * - STAGED_WEB_PROOF_GENERATION_STAMP, its code half (#7596 B2c, owner
 *   decision 4). The evidence, each a named test, is listed in
 *   docs/auth/better-auth-rollout.md ("Code gates"): the staged proof carries the
 *   generation read where the credential was verified; under `better-auth` www
 *   never stamps a sign-in from its own read; a moved, zero or missing stamp is
 *   denied by the bridge and by admission; a no-SID cookie is never bridged into
 *   an account cutoff, and its sign-out (web-session command) ends the presented
 *   cookie's id and its rotations even before it was bridged.
 *   What no code can show stays as HISTORICAL_WEB_ISSUER_RETIREMENT.
 */
export const HISTORICAL_WEB_ISSUER_RETIREMENT = 'HISTORICAL_WEB_ISSUER_RETIREMENT';

/**
 * - GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION: real-watch QA.
 * - HISTORICAL_WEB_ISSUER_RETIREMENT: owner only. The owner confirms that the
 *   old Vercel project's deployments and every rollback issuer that could still
 *   mint a web cookie under the old rules are retired; a reviewed PR that
 *   records that confirmation removes the entry. It is not a `better-auth`
 *   precondition: the bridge and the staged login write only under an enforced
 *   manifest, and only `activate`, which this list blocks, writes one.
 */
export const AUTHORITY_ACTIVATION_BLOCKERS: readonly string[] = Object.freeze([
  'GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION',
  HISTORICAL_WEB_ISSUER_RETIREMENT,
]);
export function assertAuthorityActivationGates(): void {
  if (AUTHORITY_ACTIVATION_BLOCKERS.length) throw new Error('ACTIVATION_CODE_GATES_OPEN');
}
