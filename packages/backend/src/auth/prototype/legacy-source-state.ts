import { createHash } from 'node:crypto';
import { and, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import * as schema from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';

type SourceStateDatabase = Pick<PrototypeDatabase, 'insert' | 'select'>;

/** Persist inside the same fenced transaction that removes the canonical session. */
export async function recordPrototypeCanonicalSignout(
  database: SourceStateDatabase,
  session: { id: string; userId: string; expiresAt: Date; createdAt: Date },
): Promise<void> {
  await database
    .insert(schema.prototypeLegacyLineage)
    .values({
      id: `canonical-signout:${createHash('sha256').update(session.id).digest('hex')}`,
      userId: session.userId,
      sessionId: session.id,
      originalAuthenticatedAt: session.createdAt,
      originalExpiresAt: session.expiresAt,
      revokedAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * A source-less old credential cannot establish which session authenticated it.
 * Apply only to new admissions, after checking an exact existing live binding.
 * This denial has no token-cleanup TTL. It never revokes another live session.
 */
export async function hasPrototypeLegacySourceDenial(
  database: Pick<PrototypeDatabase, 'select'>,
  userId: string,
): Promise<boolean> {
  const [denial] = await database
    .select({ id: schema.prototypeLegacyLineage.id })
    .from(schema.prototypeLegacyLineage)
    .leftJoin(
      schema.session,
      and(
        eq(schema.session.id, schema.prototypeLegacyLineage.sessionId),
        eq(schema.session.userId, schema.prototypeLegacyLineage.userId),
      ),
    )
    .where(
      and(
        eq(schema.prototypeLegacyLineage.userId, userId),
        or(
          isNotNull(schema.prototypeLegacyLineage.revokedAt),
          isNull(schema.session.id),
          lte(schema.session.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);
  return Boolean(denial);
}
