import { and, type SQL } from 'drizzle-orm';
import { boardClimbs } from '@boardsesh/db/schema';
import { contentVisibilityCondition, sprayClimbVisibilityCondition } from '@boardsesh/db/queries';

/** Match existence is independent from permission to disclose the matching author/content. */
export function duplicateDisclosureCondition(viewerId: string | null | undefined): SQL {
  return and(
    contentVisibilityCondition('climb', boardClimbs.uuid, boardClimbs.userId, viewerId),
    sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, viewerId),
  )!;
}

export function projectDuplicateIdentity(match: { uuid: string; name: string | null; canViewDetails: boolean }) {
  return match.canViewDetails === true ? { uuid: match.uuid, name: match.name } : { uuid: null, name: null };
}
