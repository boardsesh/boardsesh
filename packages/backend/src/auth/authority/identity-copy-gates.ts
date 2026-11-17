import { LEGACY_WEB_IDENTITY_WRITERS } from '@boardsesh/db/client/config';

/**
 * Code gates on copying identities into the canonical store: the identity
 * mirror's startup and the identity import both refuse while any remains.
 * Neither an environment variable nor an operator flag closes one; a reviewed
 * code change removes the entry once its writer is gone.
 *
 * LEGACY_WEB_IDENTITY_WRITERS: the Next.js web still writes `users`,
 * `user_credentials` and `accounts` over its own DATABASE_URL (registration,
 * password reset, set-password, email verification and the NextAuth adapter's
 * account links). Those writes never pass through the mirror, so a copy made
 * now goes stale behind them (an old password keeps working after a web reset;
 * a web Google link has no canonical row) and reconciliation cannot close the
 * gap while they continue. `verifyFence` only proves the restricted
 * `boardsesh_web` LOGIN cannot write; nothing a database shows proves the web
 * connects as it. The entry is defined once, beside the web's own list
 * WEB_DATABASE_LOGIN_BLOCKERS in packages/db/src/client/config.ts: one change
 * removes it from both, and sync-identity.test.ts fails if only one has it.
 */
export const IDENTITY_COPY_BLOCKERS: readonly string[] = Object.freeze([LEGACY_WEB_IDENTITY_WRITERS]);

export function assertIdentityCopyGates(): void {
  if (IDENTITY_COPY_BLOCKERS.length) throw new Error('IDENTITY_COPY_CODE_GATES_OPEN');
}
