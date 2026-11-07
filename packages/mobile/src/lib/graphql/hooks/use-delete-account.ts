import { useMutation, useQuery } from '@tanstack/react-query';
import {
  GET_DELETE_ACCOUNT_INFO,
  DELETE_ACCOUNT,
  type GetDeleteAccountInfoQueryResponse,
  type DeleteAccountMutationVariables,
  type DeleteAccountMutationResponse,
} from '@boardsesh/graphql/operations/account';
import { getHttpClient } from '../client';
import { isAuthCredentialGenerationCurrent } from '../../auth-store';
import { captureAccountDeletionIntent, type AccountDeletionResult } from '../../account-deletion-intent';
import { forgetSignupConversion } from '../../signup-conversion';

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
    retry: false,
    mutationFn: async ({
      credentialGeneration,
      ...variables
    }: DeleteAccountMutationVariables & { credentialGeneration: number }): Promise<AccountDeletionResult> => {
      // This generation belongs to the confirm tap, before TanStack's awaited
      // onMutate boundary. It is local metadata and never reaches GraphQL.
      const intent = await captureAccountDeletionIntent(credentialGeneration);
      if (!isAuthCredentialGenerationCurrent(credentialGeneration)) {
        throw new Error('Account credentials changed before account deletion');
      }
      const response = await getHttpClient().request<DeleteAccountMutationResponse>(DELETE_ACCOUNT, variables);
      if (response.deleteAccount !== true) return { deleted: false };
      if (isAuthCredentialGenerationCurrent(credentialGeneration)) {
        // A delayed/rejected local delete must not block sign-out after server deletion.
        void forgetSignupConversion(intent.userId).catch(() => {});
      }
      return { deleted: true, intent };
    },
  });
}
