import type { SQL } from 'drizzle-orm';
import { boardClimbs } from '@boardsesh/db/schema';
import { sprayClimbVisibilityCondition } from '@boardsesh/db/queries';

/**
 * Match existence is independent from permission to disclose the matching
 * climb. A published climb is public whoever set it, so the only thing left to
 * withhold is a climb on a spray wall the viewer may not see. Both duplicate
 * queries already match published climbs alone, so no draft reaches this.
 */
export function duplicateDisclosureCondition(viewerId: string | null | undefined): SQL {
  return sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, viewerId);
}

export function projectDuplicateIdentity(match: { uuid: string; name: string | null; canViewDetails: boolean }) {
  return match.canViewDetails === true ? { uuid: match.uuid, name: match.name } : { uuid: null, name: null };
}
