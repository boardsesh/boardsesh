import { createHash } from 'node:crypto';
import { eq, like, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';

export type PrototypeRecoveryPurpose = 'password-reset' | 'email-verification';
export const PROTOTYPE_LEGACY_RECOVERY_PREFIX = 'prototype-legacy-recovery:';
const MAX_LEGACY_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function prototypeRecoveryCutoffId(userId: string, purpose: PrototypeRecoveryPurpose): string {
  return `${PROTOTYPE_LEGACY_RECOVERY_PREFIX}cutoff:${createHash('sha256')
    .update(JSON.stringify([userId, purpose]))
    .digest('hex')}`;
}

/**
 * Called inside the credential mutation transaction under the common lifecycle
 * fence. This state is separate from ordinary sign-out/session cutoffs: signing
 * out must not silently invalidate a still-valid mailbox recovery link.
 *
 * A stable user/purpose tombstone also rejects delayed imports never seen before
 * the mutation. The caller's chosen migration date cannot create another epoch.
 */
export async function invalidatePrototypeLegacyRecovery(
  database: Pick<PrototypeDatabase, 'select' | 'insert' | 'update'>,
  userId: string,
  purposes: readonly PrototypeRecoveryPurpose[] = ['password-reset', 'email-verification'],
): Promise<void> {
  const supersededAt = new Date();
  for (const purpose of purposes) {
    const identifier = prototypeRecoveryCutoffId(userId, purpose);
    await database
      .insert(schema.verification)
      .values({
        id: identifier,
        identifier,
        value: 'superseded',
        expiresAt: new Date(supersededAt.getTime() + MAX_LEGACY_LINK_LIFETIME_MS),
      })
      .onConflictDoUpdate({
        target: schema.verification.id,
        set: { expiresAt: sql`greatest(${schema.verification.expiresAt}, excluded.expires_at)` },
      });
  }
  // A bounded fixture scan; a production lifecycle store needs indexed ownership.
  const candidates = await database
    .select()
    .from(schema.verification)
    .where(like(schema.verification.identifier, `${PROTOTYPE_LEGACY_RECOVERY_PREFIX}%`));
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.value);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const binding = parsed as Record<string, unknown>;
    if (
      binding.type !== 'prototype-legacy-recovery' ||
      binding.userId !== userId ||
      !purposes.some((purpose) => purpose === binding.purpose) ||
      binding.consumedAt ||
      binding.supersededAt
    )
      continue;
    await database
      .update(schema.verification)
      .set({ value: JSON.stringify({ ...binding, supersededAt: supersededAt.toISOString() }) })
      .where(eq(schema.verification.id, candidate.id));
  }
}
