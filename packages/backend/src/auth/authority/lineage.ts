import { and, eq, sql } from 'drizzle-orm';
import { authCredentialLineage, authSession, authSessionDenials, users } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';
import { requireReadCommitted } from '../current-store/foundation-context';
import type { FirstPartySession } from './session-reader';

// Include the installed JWE acceptance tolerance in the retention bound. A
// renewed legacy cookie may outlive the canonical session's original expiry.
const LEGACY_WEB_MAX_LIFETIME_MS = (30 * 24 * 60 * 60 + 60) * 1000;

/** A stale tab ends its own login only; it never names the browser's new login. */
export async function denyFirstPartySession(
  database: AuthorityDatabase,
  session: FirstPartySession,
  now = new Date(),
): Promise<void> {
  await database.transaction(async (transaction) => {
    await requireReadCommitted(transaction);
    await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
    await transaction.select({ id: users.id }).from(users).where(eq(users.id, session.userId)).for('update');
    const expiresAt = new Date(
      Math.max(session.expiresAt.getTime() + 60_000, now.getTime() + LEGACY_WEB_MAX_LIFETIME_MS),
    );
    await transaction
      .delete(authSession)
      .where(and(eq(authSession.id, session.authSessionId), eq(authSession.userId, session.userId)));
    await transaction
      .update(authCredentialLineage)
      .set({ revokedAt: now })
      .where(
        and(
          eq(authCredentialLineage.userId, session.userId),
          eq(authCredentialLineage.sessionId, session.authSessionId),
        ),
      );
    await transaction
      .insert(authSessionDenials)
      .values({
        sessionId: session.authSessionId,
        userId: session.userId,
        deniedAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: authSessionDenials.sessionId,
        set: { expiresAt: sql`greatest(${authSessionDenials.expiresAt}, excluded.expires_at)` },
        setWhere: eq(authSessionDenials.userId, session.userId),
      });
  });
}
