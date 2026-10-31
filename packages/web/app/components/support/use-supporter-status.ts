'use client';

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { readGraphqlErrorCode } from '@boardsesh/graphql/errors';
import {
  CLAIM_SUPPORTER_BY_EMAIL,
  GET_MY_SUPPORTER_STATUS,
  UPDATE_SUPPORTER_VISIBILITY,
  type ClaimSupporterByEmailResponse,
  type GetMySupporterStatusResponse,
  type MySupporterStatus,
  type UpdateSupporterVisibilityResponse,
  type UpdateSupporterVisibilityVariables,
} from '@boardsesh/graphql/operations/support';
import { executeGraphQL } from '@/app/lib/graphql/client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';

/** What "Already gave? Link it" found, in the terms the copy uses. */
export type SupporterLinkOutcome =
  | 'linked'
  | 'expired'
  | 'notFound'
  | 'emailNotVerified'
  | 'unavailable'
  | 'rateLimited'
  | 'failed';

/** A claim's result as one outcome: whether it is a supporter now, or why the lookup could not run. */
export function linkOutcomeFromStatus(status: MySupporterStatus): SupporterLinkOutcome {
  if (status.isSupporter) return 'linked';
  // A source means support was recorded once and has since run out.
  return status.source ? 'expired' : 'notFound';
}

export function linkOutcomeFromError(error: unknown): SupporterLinkOutcome {
  switch (readGraphqlErrorCode(error)) {
    case 'EMAIL_NOT_VERIFIED':
      return 'emailNotVerified';
    case 'SERVICE_UNAVAILABLE':
      return 'unavailable';
    case 'RATE_LIMITED':
      return 'rateLimited';
    default:
      return 'failed';
  }
}

export const MY_SUPPORTER_STATUS_QUERY_KEY = 'mySupporterStatus';

/**
 * The signed-in climber's supporter record, the public-credit switch and the
 * claim-by-email action, for the `/support` thank-you card and `/settings`.
 * Signed out, `isSignedIn` is false and nothing is fetched.
 */
export function useSupporterStatus() {
  const { data: session, status: sessionStatus } = useSession();
  const userId = session?.user?.id ?? null;
  const { token, isLoading: tokenLoading } = useWsAuthToken();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => [MY_SUPPORTER_STATUS_QUERY_KEY, userId] as const, [userId]);
  const [linkOutcome, setLinkOutcome] = useState<SupporterLinkOutcome | null>(null);
  const [visibilityFailed, setVisibilityFailed] = useState(false);

  const statusQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await executeGraphQL<GetMySupporterStatusResponse>(GET_MY_SUPPORTER_STATUS, {}, token);
      return response.mySupporterStatus;
    },
    enabled: Boolean(userId && token),
    staleTime: 60_000,
  });

  const visibilityMutation = useMutation({
    mutationFn: async (showPublicly: boolean) => {
      const response = await executeGraphQL<UpdateSupporterVisibilityResponse, UpdateSupporterVisibilityVariables>(
        UPDATE_SUPPORTER_VISIBILITY,
        { showPublicly },
        token,
      );
      return response.updateSupporterVisibility;
    },
    onMutate: () => setVisibilityFailed(false),
    onSuccess: (status) => queryClient.setQueryData(queryKey, status),
    onError: () => setVisibilityFailed(true),
  });

  const claimMutation = useMutation({
    mutationFn: async () => {
      const response = await executeGraphQL<ClaimSupporterByEmailResponse>(CLAIM_SUPPORTER_BY_EMAIL, {}, token);
      return response.claimSupporterByEmail;
    },
    onMutate: () => setLinkOutcome(null),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKey, status);
      setLinkOutcome(linkOutcomeFromStatus(status));
    },
    onError: (error) => setLinkOutcome(linkOutcomeFromError(error)),
  });

  const { mutate: mutateVisibility } = visibilityMutation;
  const { mutate: mutateClaim } = claimMutation;
  const setShowPublicly = useCallback((showPublicly: boolean) => mutateVisibility(showPublicly), [mutateVisibility]);
  const linkPastGift = useCallback(() => mutateClaim(), [mutateClaim]);

  const isSignedIn = sessionStatus === 'authenticated' && Boolean(userId);
  return {
    isSignedIn,
    isSessionLoading: sessionStatus === 'loading',
    email: session?.user?.email ?? null,
    status: statusQuery.data ?? null,
    isStatusLoading: isSignedIn && (tokenLoading || statusQuery.isLoading),
    // No token once the token fetch settled means the backend cannot be asked at all.
    statusFailed: statusQuery.isError || (isSignedIn && !tokenLoading && !token),
    setShowPublicly,
    isSavingVisibility: visibilityMutation.isPending,
    visibilityFailed,
    linkPastGift,
    isLinking: claimMutation.isPending,
    linkOutcome,
  };
}
