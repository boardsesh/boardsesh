/**
 * Why a revert was refused, from the `extensions.code` the backend tags it with
 * (`GYM_CLAIM_REVERT_CODES` in packages/backend/src/graphql/resolvers/social/gym-claim-revert.ts).
 * Every refusal but `failed` names a fact about the gym, and all of them except
 * `notApproved` point the admin at Move gym ownership.
 */
export type GymClaimRevertRefusal =
  | 'notFound'
  | 'notApproved'
  | 'notTransferred'
  | 'ownerChanged'
  | 'priorOwner'
  | 'failed';

const REVERT_REFUSALS: Record<string, GymClaimRevertRefusal> = {
  GYM_CLAIM_REVERT_NOT_FOUND: 'notFound',
  GYM_CLAIM_REVERT_NOT_APPROVED: 'notApproved',
  GYM_CLAIM_REVERT_NOT_TRANSFERRED: 'notTransferred',
  GYM_CLAIM_REVERT_OWNER_CHANGED: 'ownerChanged',
  GYM_CLAIM_REVERT_PRIOR_OWNER: 'priorOwner',
};

type GraphqlErrorLike = { extensions?: { code?: unknown } | null };

/** The first `extensions.code` on a graphql-request error, read the way the queue above reads its own. */
export function graphqlErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { errors?: GraphqlErrorLike[] } }).response;
  const graphqlErrors = Array.isArray(response?.errors) ? response.errors : [];
  for (const graphqlError of graphqlErrors) {
    const code = graphqlError.extensions?.code;
    if (typeof code === 'string') return code;
  }
  return null;
}

export function revertRefusal(error: unknown): GymClaimRevertRefusal {
  const code = graphqlErrorCode(error);
  return (code && REVERT_REFUSALS[code]) || 'failed';
}

/**
 * `?revert=<claim id>` from the daily digest's link: a positive whole number, or
 * nothing. Anything else is ignored rather than sent to the server.
 */
export function parseRevertParam(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return /^[1-9]\d{0,18}$/.test(trimmed) ? trimmed : null;
}
