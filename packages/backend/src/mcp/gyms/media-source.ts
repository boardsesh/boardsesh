import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { gymDirectoryRepairAudit } from '@boardsesh/db/schema';
import { db } from '../../db/client';

export const gymImageAttributionSchema = z
  .object({
    pageUrl: z.url().max(2048).optional().describe('The page that identifies the original image source.'),
    credit: z.string().trim().min(1).max(500).describe('Photographer, gym or rights-holder credit.'),
    license: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export interface GymImageSource {
  imageUrl: string;
  attribution?: z.output<typeof gymImageAttributionSchema>;
}

export async function recordGymImageSource(input: {
  gymId: number;
  gymUuid: string;
  actorUserId: string;
  kind: 'photo' | 'logo';
  previousUrl: string | null;
  storedUrl: string | null;
  source: GymImageSource | null;
}): Promise<void> {
  await db.insert(gymDirectoryRepairAudit).values({
    operation: `set_gym_image:${input.kind}`,
    gymId: input.gymId,
    gymUuid: input.gymUuid,
    actorUserId: input.actorUserId,
    reason: input.source ? 'Confirmed gym image import.' : 'Confirmed gym image removal.',
    before: { storedUrl: input.previousUrl },
    after: { storedUrl: input.storedUrl },
    details: input.source,
  });
}

/** Only return provenance for the image currently saved on this gym. */
export async function getGymImageSource(gymUuid: string, kind: 'photo' | 'logo', storedUrl: string | null) {
  if (!storedUrl) return { gymUuid, kind, storedUrl, source: null };
  const [receipt] = await db
    .select({ after: gymDirectoryRepairAudit.after, source: gymDirectoryRepairAudit.details })
    .from(gymDirectoryRepairAudit)
    .where(
      and(eq(gymDirectoryRepairAudit.gymUuid, gymUuid), eq(gymDirectoryRepairAudit.operation, `set_gym_image:${kind}`)),
    )
    .orderBy(desc(gymDirectoryRepairAudit.id))
    .limit(1);
  const saved = receipt?.after;
  const matches = saved !== null && typeof saved === 'object' && 'storedUrl' in saved && saved.storedUrl === storedUrl;
  return { gymUuid, kind, storedUrl, source: matches ? (receipt?.source ?? null) : null };
}
