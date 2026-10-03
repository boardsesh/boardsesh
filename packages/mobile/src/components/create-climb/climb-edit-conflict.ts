import { extractGraphqlCode } from '../../lib/graphql/extract-error-message';

/**
 * `extensions.code` on the refusal `updateClimb` gives a save that was decided
 * on a row another edit has since replaced (#5955). A spray climb has two
 * possible editors, its setter and anyone who can edit the wall, so two saves
 * can cross. Mirrors `CLIMB_EDIT_CONFLICT_ERROR_CODE` in the backend's
 * `climb-revisions.ts`; the constant is not exported to clients.
 */
export const CLIMB_EDIT_CONFLICT_CODE = 'CLIMB_EDIT_CONFLICT';

/**
 * Whether a failed save was that refusal.
 *
 * Matched on the code, never on the message text: the server's prose is not a
 * contract and is not translated. Reads the code off `GraphQLOperationError`
 * (which lifts the first coded error's extensions onto itself) and off a raw
 * graphql-request error alike.
 */
export function isClimbEditConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const lifted = (error as { extensions?: { code?: unknown } | null }).extensions?.code;
  return lifted === CLIMB_EDIT_CONFLICT_CODE || extractGraphqlCode(error) === CLIMB_EDIT_CONFLICT_CODE;
}
