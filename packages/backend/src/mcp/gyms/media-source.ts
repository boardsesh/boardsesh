import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { gymDirectoryRepairAudit } from '@boardsesh/db/schema';
import { db } from '../../db/client';

export const gymImageAttributionSchema = z
  .object({
    pageUrl: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .optional()
      .describe(
        'The page that identifies the original image source. Credentials, query and fragment are not retained.',
      ),
    credit: z.string().trim().min(1).max(500).describe('Photographer, gym or rights-holder credit.'),
    license: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export interface GymImageSource {
  imageUrl: string;
  attribution?: z.output<typeof gymImageAttributionSchema>;
}

function sourceIdentifier(sourceUrl: string): string {
  const identifier = new URL(sourceUrl);
  if (identifier.protocol !== 'http:' && identifier.protocol !== 'https:') {
    throw new Error('Gym image sources require HTTP or HTTPS URLs.');
  }
  identifier.username = '';
  identifier.password = '';
  identifier.search = '';
  identifier.hash = '';
  return identifier.toString();
}

function previousImageIdentifier(previousUrl: string | null): string | null {
  if (!previousUrl) return null;
  try {
    if (previousUrl.startsWith('/') && !previousUrl.startsWith('//')) {
      return new URL(previousUrl, 'https://www.boardsesh.com').pathname;
    }
    return sourceIdentifier(previousUrl);
  } catch {
    // An invalid legacy URL must never prevent replacing or removing an image.
    return null;
  }
}

/** Fetch URLs can contain short-lived bearer material; audit only their public identifier. */
function sanitizeGymImageSource(source: GymImageSource): GymImageSource {
  return {
    imageUrl: sourceIdentifier(source.imageUrl),
    ...(source.attribution
      ? {
          attribution: {
            ...source.attribution,
            ...(source.attribution.pageUrl ? { pageUrl: sourceIdentifier(source.attribution.pageUrl) } : {}),
          },
        }
      : {}),
  };
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
    before: { storedUrl: previousImageIdentifier(input.previousUrl) },
    after: { storedUrl: input.storedUrl },
    details: input.source ? sanitizeGymImageSource(input.source) : null,
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
