import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type MutateOptions } from '@tanstack/react-query';
import {
  APPROVE_FOLLOW_REQUEST,
  CANCEL_FOLLOW_REQUEST,
  DECLINE_FOLLOW_REQUEST,
  GET_INCOMING_FOLLOW_REQUESTS,
  GET_PRIVACY_RELATIONSHIP,
  GET_PRIVACY_SETTINGS,
  GET_PROFILE_PRIVACY,
  REMOVE_FOLLOWER,
  REQUEST_FOLLOW,
  SET_ANONYMOUS_ON_FOREIGN_BOARDS,
  SET_CONTENT_AUDIENCE,
  UPDATE_PRIVACY_SETTINGS,
  type PrivacyAudience,
  type PrivacyContentType,
  type PrivacyFollowRequest,
  type PrivacyRelationship,
  type PrivacySettings,
  type UpdatePrivacySettingsInput,
} from '@boardsesh/graphql/operations/privacy';
import { getHttpClient } from '../client';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../../auth-store';
import { useProfile } from './index';
import { getConnectivitySnapshot } from '../../connectivity/connectivity-store';
import { refreshAfterOwnPrivacyChange } from '../../privacy/privacy-cache';

/** Feature discovery fails closed against backends that predate privacy enforcement. */
export function usePrivacySettings() {
  const { data: profile } = useProfile();
  return useQuery({
    queryKey: ['privacySettings', profile?.id],
    queryFn: async ({ signal }) => {
      const response = await getHttpClient().request<{ privacySettings: PrivacySettings }>({
        document: GET_PRIVACY_SETTINGS,
        signal,
      });
      return response.privacySettings;
    },
    enabled: !!profile?.id,
    retry: false,
    staleTime: 30_000,
  });
}

function requireConnected(): void {
  if (getConnectivitySnapshot().effectiveOffline) throw new Error('Privacy changes require a connection.');
}

/**
 * Mutation responses can precede another save, so a fresh read replaces the
 * snapshot; the response only stands in when that read failed or never ran.
 */
function usePrivacySettingsWrite<Input>(write: (input: Input) => Promise<PrivacySettings>) {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const currentViewerId = useRef(profile?.id);
  currentViewerId.current = profile?.id;
  const scope = { viewerId: profile?.id, credentialGeneration: captureAuthCredentialGeneration() };
  const requireCurrentScope = (candidate: typeof scope) => {
    if (
      !candidate.viewerId ||
      currentViewerId.current !== candidate.viewerId ||
      !isAuthCredentialGenerationCurrent(candidate.credentialGeneration)
    ) {
      throw new Error('Privacy changes require the same signed-in account.');
    }
  };
  type Request = { input: Input; scope: typeof scope };
  type Callbacks = MutateOptions<PrivacySettings, Error, Input, undefined>;
  const mutation = useMutation<PrivacySettings, Error, Request, undefined>({
    networkMode: 'always',
    mutationFn: async (request) => {
      requireConnected();
      requireCurrentScope(request.scope);
      const settings = await write(request.input);
      requireCurrentScope(request.scope);
      return settings;
    },
    onSuccess: async (settings, request) => {
      requireCurrentScope(request.scope);
      const savedAt = Date.now();
      await refreshAfterOwnPrivacyChange(queryClient);
      requireCurrentScope(request.scope);
      // The refetch above replaces the snapshot, and a read that landed after the
      // save wins. When the refetch failed (error state) or did not run (data
      // older than the save), keep this save's acknowledged settings on screen.
      const settingsKey = ['privacySettings', request.scope.viewerId];
      const settingsState = queryClient.getQueryState(settingsKey);
      if (!settingsState || settingsState.status === 'error' || settingsState.dataUpdatedAt < savedAt)
        queryClient.setQueryData(settingsKey, settings);
    },
  });
  const callbacksFor = (
    input: Input,
    callbacks?: Callbacks,
  ): MutateOptions<PrivacySettings, Error, Request, undefined> | undefined =>
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
    variables: mutation.variables?.input,
    // TanStack can replace mutation options across its awaited onMutate boundary.
    // Keep the invocation's viewer/credential scope in immutable variables.
    mutate: (input: Input, callbacks?: Callbacks) => mutation.mutate({ input, scope }, callbacksFor(input, callbacks)),
    mutateAsync: (input: Input, callbacks?: Callbacks) =>
      mutation.mutateAsync({ input, scope }, callbacksFor(input, callbacks)),
  };
}

export function useUpdatePrivacySettings() {
  return usePrivacySettingsWrite(async (input: UpdatePrivacySettingsInput) => {
    const response = await getHttpClient().request<{ updatePrivacySettings: PrivacySettings }>(
      UPDATE_PRIVACY_SETTINGS,
      { input },
    );
    return response.updatePrivacySettings;
  });
}

/**
 * "Stay anonymous on boards I don't own". A plain preference, so it saves
 * whether or not account privacy controls are enabled on the server.
 */
export function useSetAnonymousOnForeignBoards() {
  return usePrivacySettingsWrite(async (enabled: boolean) => {
    const response = await getHttpClient().request<{ setAnonymousOnForeignBoards: PrivacySettings }>(
      SET_ANONYMOUS_ON_FOREIGN_BOARDS,
      { enabled },
    );
    return response.setAnonymousOnForeignBoards;
  });
}

export function useIncomingFollowRequests(enabled: boolean) {
  const { data: profile } = useProfile();
  return useQuery({
    queryKey: ['privacyFollowRequests', profile?.id],
    queryFn: async ({ signal }) => {
      const response = await getHttpClient().request<{ incomingFollowRequests: PrivacyFollowRequest[] }>({
        document: GET_INCOMING_FOLLOW_REQUESTS,
        signal,
      });
      return response.incomingFollowRequests;
    },
    enabled: enabled && !!profile?.id,
  });
}

export function usePrivacyRelationship(userId: string, enabled: boolean) {
  const { data: profile } = useProfile();
  return useQuery({
    queryKey: ['privacyRelationship', profile?.id, userId],
    queryFn: async ({ signal }) => {
      const response = await getHttpClient().request<{ privacyRelationship: PrivacyRelationship }>({
        document: GET_PRIVACY_RELATIONSHIP,
        variables: { userId },
        signal,
      });
      return response.privacyRelationship;
    },
    enabled: enabled && !!profile?.id && profile.id !== userId,
  });
}

const FOLLOW_ACTIONS = {
  approve: APPROVE_FOLLOW_REQUEST,
  decline: DECLINE_FOLLOW_REQUEST,
  cancel: CANCEL_FOLLOW_REQUEST,
  remove: REMOVE_FOLLOWER,
  request: REQUEST_FOLLOW,
};
export function usePrivacyFollowAction() {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async ({ action, userId }: { action: keyof typeof FOLLOW_ACTIONS; userId: string }) => {
      requireConnected();
      return getHttpClient().request(FOLLOW_ACTIONS[action], { userId });
    },
    onSuccess: () => refreshAfterOwnPrivacyChange(queryClient),
  });
}

export function useSetContentAudience() {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async (input: {
      entityType: PrivacyContentType;
      entityId: string;
      audience: PrivacyAudience;
      privacyRevision: number;
    }) => {
      requireConnected();
      return getHttpClient().request(SET_CONTENT_AUDIENCE, { input });
    },
    onSuccess: () => refreshAfterOwnPrivacyChange(queryClient),
  });
}

/** Kept separate so older servers and recorded profile documents remain valid. */
export function useProfilePrivacy(userId: string) {
  const { data: settings } = usePrivacySettings();
  const { data: profile } = useProfile();
  return useQuery({
    queryKey: ['profilePrivacy', profile?.id, settings?.privacyRevision, userId],
    queryFn: async ({ signal }) =>
      (
        await getHttpClient().request<{ publicProfile: { isPrivate: boolean; canViewActivity: boolean } | null }>({
          document: GET_PROFILE_PRIVACY,
          variables: { userId },
          signal,
        })
      ).publicProfile,
    enabled: !!settings && !!userId,
  });
}
