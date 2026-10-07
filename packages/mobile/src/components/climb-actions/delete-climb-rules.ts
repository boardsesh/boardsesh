import type { Climb } from '@boardsesh/shared-schema';
import { extractGraphqlCode } from '../../lib/graphql/extract-error-message';

/**
 * "Delete climb" for a setter's own spray climb (#5960).
 *
 * The row is offered on the setter's own PUBLISHED spray climb on a live wall.
 * Drafts keep their own delete in the drafts list. Whether anybody has logged
 * the climb is the server's call alone (`CLIMB_HAS_TICKS`): the app never has
 * every tick, offline ones included, so it does not guess.
 */
export function canDeleteClimb({
  climb,
  boardName,
  currentUserId,
  wallArchived,
}: {
  climb: Pick<Climb, 'userId' | 'is_draft'> | null | undefined;
  boardName: string;
  currentUserId: string | null | undefined;
  wallArchived: boolean;
}): boolean {
  if (!climb || boardName !== 'spray' || wallArchived) return false;
  if (!currentUserId || climb.userId !== currentUserId) return false;
  return climb.is_draft !== true;
}

/** Why the server refused a delete, as far as the climber needs to know. */
export type DeleteClimbRefusal = 'hasTicks' | 'notFound' | 'notAllowed' | 'archived';

// `extensions.code` for each. Mirrors `DELETE_CLIMB_CODES` in the backend's
// `climbs/delete-climb.ts`, plus the wall's own archive code.
const REFUSAL_BY_CODE: Record<string, DeleteClimbRefusal> = {
  CLIMB_HAS_TICKS: 'hasTicks',
  CLIMB_NOT_FOUND: 'notFound',
  CLIMB_DELETE_NOT_ALLOWED: 'notAllowed',
  SPRAY_WALL_ARCHIVED: 'archived',
};

/** The refusal a failed delete was, or null for anything else (a dropped connection, a server error). */
export function deleteClimbRefusal(error: unknown): DeleteClimbRefusal | null {
  if (!error || typeof error !== 'object') return null;
  const lifted = (error as { extensions?: { code?: unknown } | null }).extensions?.code;
  const code = typeof lifted === 'string' ? lifted : extractGraphqlCode(error);
  if (!code || !Object.hasOwn(REFUSAL_BY_CODE, code)) return null;
  return REFUSAL_BY_CODE[code];
}

type Translate = (key: string) => string;

/** The toast for a failed delete. Literal keys, so the i18n orphan check can find each one. */
export function deleteClimbErrorMessage(refusal: DeleteClimbRefusal | null, t: Translate): string {
  switch (refusal) {
    case 'hasTicks':
      return t('mobile.climbActions.deleteClimb.hasTicks');
    case 'notFound':
      return t('mobile.climbActions.deleteClimb.notFound');
    case 'notAllowed':
      return t('mobile.climbActions.deleteClimb.notAllowed');
    case 'archived':
      return t('mobile.climbActions.deleteClimb.archived');
    default:
      return t('mobile.climbActions.deleteClimb.error');
  }
}
