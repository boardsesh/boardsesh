import { eq, like } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';

export const PROTOTYPE_CANONICAL_VERIFICATION_PREFIX = 'prototype-canonical-verification:';

export const prototypeVerificationBindingSchema = z.strictObject({
  type: z.literal('prototype-canonical-verification'),
  purpose: z.literal('verify-current-email'),
  userId: z.string().min(1),
  intendedEmail: z.email(),
  issuedAtSeconds: z.number().int().nonnegative(),
  expiresAtSeconds: z.number().int().positive(),
  consumedAt: z.iso.datetime().nullable(),
  supersededAt: z.iso.datetime().nullable(),
});

export type PrototypeVerificationBinding = z.infer<typeof prototypeVerificationBindingSchema>;

export function parsePrototypeVerificationBinding(serialized: string): PrototypeVerificationBinding | null {
  try {
    const parsed: unknown = JSON.parse(serialized);
    const binding = prototypeVerificationBindingSchema.safeParse(parsed);
    return binding.success ? binding.data : null;
  } catch {
    return null;
  }
}

/** Call inside the common lifecycle transaction; ordinary sign-out skips this. */
export async function invalidatePrototypeCanonicalVerification(
  database: Pick<PrototypeDatabase, 'select' | 'update'>,
  userId: string,
): Promise<void> {
  const records = await database
    .select()
    .from(schema.verification)
    .where(like(schema.verification.identifier, `${PROTOTYPE_CANONICAL_VERIFICATION_PREFIX}%`));
  const supersededAt = new Date().toISOString();
  for (const record of records) {
    const binding = parsePrototypeVerificationBinding(record.value);
    if (!binding || binding.userId !== userId || binding.consumedAt || binding.supersededAt) continue;
    await database
      .update(schema.verification)
      .set({ value: JSON.stringify({ ...binding, supersededAt }) })
      .where(eq(schema.verification.id, record.id));
  }
}
