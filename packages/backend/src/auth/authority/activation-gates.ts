/**
 * Code gates on `auth-authority activate`. Neither an environment variable nor an
 * operator flag closes one. `enforced` is database state an administrator could
 * set by hand, so the identity mirror's startup and the identity import check
 * these again rather than taking the phase as proof they closed.
 * NATIVE_REVOKE_RESET_LOCK_ORDER closed: native sign-out and staged reset both take the
 * shared gate, then the users row, before any other row of that climber
 * (native-revoke-reset-lock-order.test.ts races them in both orders).
 */
export const AUTHORITY_ACTIVATION_BLOCKERS: readonly string[] = Object.freeze([
  'GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION',
  'STAGED_WEB_PROOF_GENERATION_STAMP',
]);
export function assertAuthorityActivationGates(): void {
  if (AUTHORITY_ACTIVATION_BLOCKERS.length) throw new Error('ACTIVATION_CODE_GATES_OPEN');
}
