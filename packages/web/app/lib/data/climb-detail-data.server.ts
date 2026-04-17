import { dbz } from '@/app/lib/db/db';
import { eq, and } from 'drizzle-orm';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import { UNIFIED_TABLES } from '@/app/lib/db/queries/util/table-select';
import { climbCommunityStatus } from '@/app/lib/db/schema';
import { filterAndRevalidateBetaLinks } from '@/app/lib/beta-link-revalidation';

interface FetchClimbDetailDataParams {
  boardName: string;
  climbUuid: string;
  angle: number;
}

export async function fetchClimbDetailData({ boardName, climbUuid, angle }: FetchClimbDetailDataParams) {
  const fetchBetaLinks = async (): Promise<BetaLink[]> => {
    try {
      const { betaLinks } = UNIFIED_TABLES;
      const results = await dbz
        .select()
        .from(betaLinks)
        .where(
          and(eq(betaLinks.boardType, boardName), eq(betaLinks.climbUuid, climbUuid)),
        );

      // Hide rows we've affirmatively marked broken, and kick off
      // background revalidation for unknown/stale rows. Same rule the
      // `/api/v1/.../beta/...` route uses — keep them in lockstep.
      const visible = filterAndRevalidateBetaLinks(results);

      return visible.map((link) => ({
        climb_uuid: link.climbUuid,
        link: link.link,
        foreign_username: link.foreignUsername,
        angle: link.angle,
        thumbnail: link.thumbnail,
        is_listed: link.isListed ?? false,
        created_at: link.createdAt ?? new Date().toISOString(),
      }));
    } catch {
      return [];
    }
  };

  const fetchCommunityGrade = async (): Promise<string | null> => {
    try {
      const [result] = await dbz
        .select({ communityGrade: climbCommunityStatus.communityGrade })
        .from(climbCommunityStatus)
        .where(
          and(
            eq(climbCommunityStatus.climbUuid, climbUuid),
            eq(climbCommunityStatus.boardType, boardName),
            eq(climbCommunityStatus.angle, angle),
          ),
        )
        .limit(1);

      return result?.communityGrade ?? null;
    } catch {
      return null;
    }
  };

  const [betaLinks, communityGrade] = await Promise.all([
    fetchBetaLinks(),
    fetchCommunityGrade(),
  ]);

  return { betaLinks, communityGrade };
}
