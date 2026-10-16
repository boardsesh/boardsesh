import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type MutateOptions } from '@tanstack/react-query';
import type { LeaderboardVisibility } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
import {
  GET_STANDINGS_PRIVACY,
  UPDATE_STANDINGS_PRIVACY,
  type GetStandingsPrivacyQueryResponse,
  type UpdateStandingsPrivacyMutationResponse,
} from '../operations';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../../auth-store';
import { getConnectivitySnapshot } from '../../connectivity/connectivity-store';
import { refreshAfterOwnPrivacyChange } from '../../privacy/privacy-cache';

export type StandingsPrivacy = NonNullable<GetStandingsPrivacyQueryResponse['profile']>;
export type StandingsPrivacyInput =
  | { leaderboardVisibility: LeaderboardVisibility; gymScreenVisibility?: never }
  | { gymScreenVisibility: LeaderboardVisibility; leaderboardVisibility?: never };

const standingsPrivacyKey = (viewerId: string | undefined, credentialGeneration: number) =>
  ['standingsPrivacy', viewerId, credentialGeneration] as const;

/** Isolated from the widely used profile document and scoped to the signed-in account. */
export function useStandingsPrivacy(viewerId: string | undefined) {
  const credentialGeneration = captureAuthCredentialGeneration();
  return useQuery({
    queryKey: standingsPrivacyKey(viewerId, credentialGeneration),
    queryFn: async ({ signal }) => {
      const response = await getHttpClient().request<GetStandingsPrivacyQueryResponse>({
        document: GET_STANDINGS_PRIVACY,
        signal,
      });
      if (!isAuthCredentialGenerationCurrent(credentialGeneration)) throw new Error('Signed-in account changed.');
      return response.profile;
    },
    enabled: !!viewerId,
    retry: false,
    staleTime: 30_000,
  });
}

/** One explicit audience choice, with the same offline and account fences as other privacy writes. */
export function useUpdateStandingsPrivacy(viewerId: string | undefined) {
  const queryClient = useQueryClient();
  const currentViewerId = useRef(viewerId);
  currentViewerId.current = viewerId;
  const scope = { viewerId, credentialGeneration: captureAuthCredentialGeneration() };
  const requireCurrentScope = (candidate: typeof scope) => {
    if (
      !candidate.viewerId ||
      candidate.viewerId !== currentViewerId.current ||
      !isAuthCredentialGenerationCurrent(candidate.credentialGeneration)
    )
      throw new Error('Privacy changes require the same signed-in account.');
  };
  type Request = { input: StandingsPrivacyInput; scope: typeof scope };
  type Callbacks = MutateOptions<StandingsPrivacy, Error, StandingsPrivacyInput, undefined>;
  const mutation = useMutation<StandingsPrivacy, Error, Request, undefined>({
    networkMode: 'always',
    mutationFn: async (request) => {
      if (getConnectivitySnapshot().effectiveOffline) throw new Error('Privacy changes require a connection.');
      requireCurrentScope(request.scope);
      const response = await getHttpClient().request<UpdateStandingsPrivacyMutationResponse>(UPDATE_STANDINGS_PRIVACY, {
        input: request.input,
      });
      requireCurrentScope(request.scope);
      const { leaderboardVisibility, gymScreenVisibility } = response.updateProfile;
      return { leaderboardVisibility, gymScreenVisibility };
    },
    onSuccess: async (settings, request) => {
      requireCurrentScope(request.scope);
      const savedAt = Date.now();
      await refreshAfterOwnPrivacyChange(queryClient);
      requireCurrentScope(request.scope);
      const queryKey = standingsPrivacyKey(request.scope.viewerId, request.scope.credentialGeneration);
      const queryState = queryClient.getQueryState(queryKey);
      if (!queryState || queryState.status === 'error' || queryState.dataUpdatedAt < savedAt)
        queryClient.setQueryData(queryKey, settings);
    },
  });
  const callbacksFor = (
    input: StandingsPrivacyInput,
    callbacks?: Callbacks,
  ): MutateOptions<StandingsPrivacy, Error, Request, undefined> | undefined =>
    callbacks && {
      onSuccess: (settings, _request, context, mutationContext) =>
        callbacks.onSuccess?.(settings, input, context, mutationContext),
      onError: (error, _request, context, mutationContext) =>
        callbacks.onError?.(error, input, context, mutationContext),
      onSettled: (settings, error, _request, context, mutationContext) =>
        callbacks.onSettled?.(settings, error, input, context, mutationContext),
    };
  return {
    ...mutation,
    variables:
      mutation.variables &&
      mutation.variables.scope.viewerId === viewerId &&
      isAuthCredentialGenerationCurrent(mutation.variables.scope.credentialGeneration)
        ? mutation.variables.input
        : undefined,
    mutate: (input: StandingsPrivacyInput, callbacks?: Callbacks) =>
      mutation.mutate({ input, scope }, callbacksFor(input, callbacks)),
    mutateAsync: (input: StandingsPrivacyInput, callbacks?: Callbacks) =>
      mutation.mutateAsync({ input, scope }, callbacksFor(input, callbacks)),
  };
}
