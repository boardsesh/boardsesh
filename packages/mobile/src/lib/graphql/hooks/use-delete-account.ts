import { useMutation, useQuery } from '@tanstack/react-query';
import {
  GET_DELETE_ACCOUNT_INFO,
  DELETE_ACCOUNT,
  type GetDeleteAccountInfoQueryResponse,
  type DeleteAccountMutationVariables,
  type DeleteAccountMutationResponse,
} from '@boardsesh/graphql/operations/account';
import { getHttpClient } from '../client';

/**
 * Count of the signed-in user's published climbs, surfaced in the
 * delete-account confirmation. Published climbs survive deletion (the backend
 * nulls their user FK rather than removing them), so the screen shows the count
 * and offers to strip the setter name. Mirrors the web delete-account dialog's
 * GET_DELETE_ACCOUNT_INFO fetch. `staleTime: 0` so a re-open re-checks.
 */
export function useDeleteAccountInfo(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['deleteAccountInfo'],
    queryFn: () => getHttpClient().request<GetDeleteAccountInfoQueryResponse>(GET_DELETE_ACCOUNT_INFO),
    select: (data) => data.deleteAccountInfo.publishedClimbCount,
    enabled: options?.enabled ?? true,
    staleTime: 0,
  });
}

/**
 * Permanently delete the signed-in user's account. In one backend transaction
 * this removes draft climbs, optionally strips the setter name from published
 * climbs, and deletes the user row (sessions / linked accounts / credentials
 * cascade). The caller signs out on success. Same DELETE_ACCOUNT mutation the
 * web settings screen uses.
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: async (variables: DeleteAccountMutationVariables) => {
      const response = await getHttpClient().request<DeleteAccountMutationResponse>(DELETE_ACCOUNT, variables);
      return response.deleteAccount;
    },
  });
}
