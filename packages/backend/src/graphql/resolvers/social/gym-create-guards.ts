import { and, eq, isNull, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { normalizeGymName } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import type { DbTransaction } from '../../../db/after-commit';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { MAX_AUTO_MINTED_GYMS_PER_OWNER, type GymNameMatch, type SimilarGymResult } from './gym-matching';

// ============================================
// createGym guards: duplicate refusal, owner cap, create lock
// ============================================
//
// createGym used to insert whatever it was sent. The web form showed similar
// gyms as the climber typed, but nothing on the server stopped a second listing
// of a real gym, and a script could mint gyms without limit. Every create now
// runs the same similar-gym search the form shows (findSimilarGymCandidates)
// and refuses with GYM_SIMILAR_EXISTS until the climber has seen every match
// and said theirs is different. See docs/product/gym-board-governance.md.

export const GYM_SIMILAR_EXISTS_CODE = 'GYM_SIMILAR_EXISTS';
export const GYM_LIMIT_REACHED_CODE = 'GYM_LIMIT_REACHED';

export type GymDuplicateCheckMode = 'REJECT_IF_FOUND' | 'CONFIRMED_SEPARATE';

// Two-int advisory-lock namespaces, ASCII "GYMO" (gym create, per owner) and
// "GYMN" (gym create, per normalized name). Distinct from every other namespace
// in the repo; the list is in docs/product/existing-wall-check.md.
const GYM_CREATE_OWNER_LOCK_NAMESPACE = 0x47594d4f;
const GYM_CREATE_NAME_LOCK_NAMESPACE = 0x47594d4e;

/**
 * Serialize gym creates that could collide, for the rest of `transaction`:
 *
 * - per owner, so one climber's double-tapped Save (or two tabs) can't both
 *   read "no similar gym" and "24 gyms" and both insert;
 * - per normalized name, so two climbers adding the same gym by the same name
 *   at the same moment can't both pass. A different name at the same spot (the
 *   150 m tier) is not covered: there is no key both creates share.
 *
 * Always owner first, then name. A transaction holding the name lock already
 * holds its owner lock and waits on nothing else, so the order can't deadlock.
 */
export async function lockGymCreate(transaction: DbTransaction, ownerId: string, gymName: string): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(${GYM_CREATE_OWNER_LOCK_NAMESPACE}::int, hashtext(${ownerId}))`,
  );
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(${GYM_CREATE_NAME_LOCK_NAMESPACE}::int, hashtext(${normalizeGymName(gymName)}))`,
  );
}

export function gymLimitReachedError(): GraphQLError {
  return new GraphQLError(
    `You've reached the limit of ${MAX_AUTO_MINTED_GYMS_PER_OWNER} gyms on one account. ` +
      `Delete a gym you no longer run to add another.`,
    { extensions: { code: GYM_LIMIT_REACHED_CODE, maxGyms: MAX_AUTO_MINTED_GYMS_PER_OWNER } },
  );
}

/**
 * Refuse a create once the owner holds the cap of live gyms. The same 25 that
 * stops createBoard's auto-mint, and it counts the gyms that minted too.
 *
 * Read inside the create's transaction after `lockGymCreate`, so for createGym
 * it is exact: two creates by one owner can't both see 24. createBoard's mint
 * path still reads it without a lock (gym-matching.ts), which is approximate by
 * design. No exemption for admins, as the board cap has none: an admin who
 * sets gyms up for others hands them over with the owner reassignment, which
 * frees the slot. Only the system catalogue owner is exempt.
 */
export async function assertGymCapNotReached(transaction: DbTransaction, ownerId: string): Promise<void> {
  if (ownerId === SYSTEM_BOARD_OWNER_ID) return;

  const [{ count: ownedGymCount }] = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.ownerId, ownerId), isNull(dbSchema.gyms.deletedAt)));

  if (ownedGymCount >= MAX_AUTO_MINTED_GYMS_PER_OWNER) {
    throw gymLimitReachedError();
  }
}

/**
 * The similar gyms that stop a create, per the mode:
 * - REJECT_IF_FOUND: all of them.
 * - CONFIRMED_SEPARATE: those missing from `acknowledgedGymUuids`. An empty
 *   list, or one naming none of them, blocks on all of them, so a blind
 *   confirmation (a failed lookup, a script) never skips the check.
 *
 * Order is kept (nearest first, or exact name first without coordinates), so
 * the refusal names the closest matches.
 */
export function blockingSimilarGyms(
  candidates: readonly GymNameMatch[],
  mode: GymDuplicateCheckMode,
  acknowledgedGymUuids: readonly string[],
): GymNameMatch[] {
  if (mode === 'REJECT_IF_FOUND') return [...candidates];
  const acknowledged = new Set(acknowledgedGymUuids);
  return candidates.filter((candidate) => !acknowledged.has(candidate.uuid));
}

/**
 * The refusal. Unlike BOARD_EXISTING_WALLS, which names walls by uuid only,
 * this carries each gym in the `SimilarGym` shape: they are exactly what
 * findSimilarGyms returns to the same viewer (public and listed gyms, or their
 * own), so the error reads nothing the query doesn't already show, and the
 * client can render the list without a second round trip.
 */
export function similarGymsExistError(candidates: readonly SimilarGymResult[]): GraphQLError {
  return new GraphQLError('A gym like this may already be listed', {
    extensions: { code: GYM_SIMILAR_EXISTS_CODE, candidates },
  });
}
