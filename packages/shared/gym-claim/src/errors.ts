/**
 * `extensions.code` on a claim refused because the gym's own staff run it
 * (`listingState` is `RUN_BY_GYM`). Nobody can claim such a gym; a dispute
 * goes through Report a problem (docs/product/gym-board-governance.md, PR 7).
 */
export const GYM_RUN_BY_STAFF_CODE = 'GYM_RUN_BY_STAFF';

type CodedError = { extensions?: { code?: unknown } | null };

/** Every `extensions.code` a graphql-request error, or an error carrying its own extensions, holds. */
function graphqlErrorCodes(error: unknown): unknown[] {
  if (!error || typeof error !== 'object') return [];
  const lifted = (error as CodedError).extensions?.code;
  const responseErrors = (error as { response?: { errors?: unknown } }).response?.errors;
  const nested = Array.isArray(responseErrors)
    ? responseErrors.map((graphqlError) =>
        graphqlError && typeof graphqlError === 'object' ? (graphqlError as CodedError).extensions?.code : undefined,
      )
    : [];
  return [lifted, ...nested];
}

/**
 * Whether `requestGymClaim` refused because the gym's staff run it. Read from
 * the code, never the message, so both clients can say it in the climber's
 * language.
 */
export function isGymRunByStaffError(error: unknown): boolean {
  return graphqlErrorCodes(error).includes(GYM_RUN_BY_STAFF_CODE);
}
