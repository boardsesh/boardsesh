import { useRef } from 'react';
import type { GraphQLClient } from 'graphql-request';
import { useMutation, useQuery, useQueryClient, type MutateOptions, type QueryClient } from '@tanstack/react-query';
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
import { useHttpRequestScope } from '../use-http-request-scope';
import { assertCurrentHttpResult, httpScopeQueryKey, isCurrentHttpView } from '../request-scope';

/** Feature discovery fails closed against backends that predate privacy enforcement. */
export function usePrivacySettings() {
  const { data: profile } = useProfile();
  const httpScope = useHttpRequestScope();
  return useQuery({
    queryKey: httpScopeQueryKey(['privacySettings', profile?.id], httpScope),
    queryFn: async ({ signal }) => {
      const response = await getHttpClient(httpScope).request<{ privacySettings: PrivacySettings }>({
        document: GET_PRIVACY_SETTINGS,
        signal,
      });
      assertCurrentHttpResult(httpScope, response);
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
type PrivacyWriteScope = Readonly<{
  viewerId: string | undefined;
  credentialGeneration: number;
  httpScope: string | undefined;
}>;

function useScopedPrivacyWrite<Input, Output>(
  write: (client: GraphQLClient, input: Input) => Promise<Output>,
  complete?: (
    output: Output,
    scope: PrivacyWriteScope,
    queryClient: QueryClient,
    assertCurrent: () => void,
  ) => Promise<void>,
) {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const httpScope = useHttpRequestScope();
  const currentViewerId = useRef(profile?.id);
  currentViewerId.current = profile?.id;
  const scope = Object.freeze({
    viewerId: profile?.id,
    credentialGeneration: captureAuthCredentialGeneration(),
    httpScope,
  });
  const requireCurrentScope = (candidate: typeof scope) => {
    if (
      !candidate.viewerId ||
      currentViewerId.current !== candidate.viewerId ||
      !isAuthCredentialGenerationCurrent(candidate.credentialGeneration) ||
      !isCurrentHttpView(candidate.httpScope)
    ) {
      throw new Error('Privacy changes require the same signed-in account.');
    }
  };
  type Request = { input: Input; scope: typeof scope };
  type Callbacks = MutateOptions<Output, Error, Input, undefined>;
  const mutation = useMutation<Output, Error, Request, undefined>({
    networkMode: 'always',
    mutationFn: async (request) => {
      requireConnected();
      requireCurrentScope(request.scope);
      const output = await write(getHttpClient(request.scope.httpScope), request.input);
      requireCurrentScope(request.scope);
      assertCurrentHttpResult(request.scope.httpScope, output);
      return output;
    },
    onSuccess: async (output, request) => {
      const assertCurrent = () => {
        requireCurrentScope(request.scope);
        assertCurrentHttpResult(request.scope.httpScope, output);
      };
      assertCurrent();
      if (complete) await complete(output, request.scope, queryClient, assertCurrent);
      else await refreshAfterOwnPrivacyChange(queryClient);
      assertCurrent();
    },
  });
  const callbacksFor = (
    input: Input,
    callbacks?: Callbacks,
  ): MutateOptions<Output, Error, Request, undefined> | undefined =>
    callbacks && {
      onSuccess: (output, request, context, mutationContext) => {
        requireCurrentScope(request.scope);
        assertCurrentHttpResult(request.scope.httpScope, output);
        return callbacks.onSuccess?.(output, input, context, mutationContext);
      },
      onError: (error, request, context, mutationContext) => {
        try {
          requireCurrentScope(request.scope);
        } catch {
          return;
        }
        return callbacks.onError?.(error, input, context, mutationContext);
      },
      onSettled: (output, error, request, context, mutationContext) => {
        try {
          requireCurrentScope(request.scope);
          if (output !== undefined) assertCurrentHttpResult(request.scope.httpScope, output);
        } catch {
          return;
        }
        return callbacks.onSettled?.(output, error, input, context, mutationContext);
      },
    };
  return {
    ...mutation,
    variables: mutation.variables?.input,
    isReady: Boolean(scope.viewerId && isCurrentHttpView(scope.httpScope)),
    /** Caller-owned awaits need the actual original delivery again immediately
     * before publishing UI, cache or other effects. */
    assertCurrentResult: (output: Output) => {
      requireCurrentScope(scope);
      assertCurrentHttpResult(scope.httpScope, output);
    },
    // TanStack can replace mutation options across its awaited onMutate boundary.
    // Keep the invocation's viewer/credential scope in immutable variables.
    mutate: (input: Input, callbacks?: Callbacks) => mutation.mutate({ input, scope }, callbacksFor(input, callbacks)),
    mutateAsync: (input: Input, callbacks?: Callbacks) =>
      mutation.mutateAsync({ input, scope }, callbacksFor(input, callbacks)),
  };
}

function usePrivacySettingsWrite<Input>(write: (client: GraphQLClient, input: Input) => Promise<PrivacySettings>) {
  return useScopedPrivacyWrite(write, async (settings, scope, queryClient, assertCurrent) => {
    const savedAt = Date.now();
    await refreshAfterOwnPrivacyChange(queryClient);
    assertCurrent();
    const settingsKey = httpScopeQueryKey(['privacySettings', scope.viewerId], scope.httpScope);
    const settingsState = queryClient.getQueryState(settingsKey);
    if (!settingsState || settingsState.status === 'error' || settingsState.dataUpdatedAt < savedAt)
      queryClient.setQueryData(settingsKey, settings);
  });
}

export function useUpdatePrivacySettings() {
  return usePrivacySettingsWrite(async (client, input: UpdatePrivacySettingsInput) => {
    const response = await client.request<{ updatePrivacySettings: PrivacySettings }>(UPDATE_PRIVACY_SETTINGS, {
      input,
    });
    return response.updatePrivacySettings;
  });
}

/**
 * "Stay anonymous on boards I don't own". A plain preference, so it saves
 * whether or not account privacy controls are enabled on the server.
 */
export function useSetAnonymousOnForeignBoards() {
  return usePrivacySettingsWrite(async (client, enabled: boolean) => {
    const response = await client.request<{ setAnonymousOnForeignBoards: PrivacySettings }>(
      SET_ANONYMOUS_ON_FOREIGN_BOARDS,
      { enabled },
    );
    return response.setAnonymousOnForeignBoards;
  });
}

export function useIncomingFollowRequests(enabled: boolean) {
  const { data: profile } = useProfile();
  const httpScope = useHttpRequestScope();
  return useQuery({
    queryKey: httpScopeQueryKey(['privacyFollowRequests', profile?.id], httpScope),
    queryFn: async ({ signal }) => {
      const response = await getHttpClient(httpScope).request<{ incomingFollowRequests: PrivacyFollowRequest[] }>({
        document: GET_INCOMING_FOLLOW_REQUESTS,
        signal,
      });
      assertCurrentHttpResult(httpScope, response);
      return response.incomingFollowRequests;
    },
    enabled: enabled && !!profile?.id,
  });
}

export function usePrivacyRelationship(userId: string, enabled: boolean) {
  const { data: profile } = useProfile();
  const httpScope = useHttpRequestScope();
  return useQuery({
    queryKey: httpScopeQueryKey(['privacyRelationship', profile?.id, userId], httpScope),
    queryFn: async ({ signal }) => {
      const response = await getHttpClient(httpScope).request<{ privacyRelationship: PrivacyRelationship }>({
        document: GET_PRIVACY_RELATIONSHIP,
        variables: { userId },
        signal,
      });
      assertCurrentHttpResult(httpScope, response);
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
  return useScopedPrivacyWrite(
    async (client, { action, userId }: { action: keyof typeof FOLLOW_ACTIONS; userId: string }) =>
      client.request(FOLLOW_ACTIONS[action], { userId }),
  );
}

export function useSetContentAudience() {
  return useScopedPrivacyWrite(
    async (
      client,
      input: {
        entityType: PrivacyContentType;
        entityId: string;
        audience: PrivacyAudience;
        privacyRevision: number;
      },
    ) => client.request(SET_CONTENT_AUDIENCE, { input }),
  );
}

/** Kept separate so older servers and recorded profile documents remain valid. */
export function useProfilePrivacy(userId: string) {
  const { data: settings } = usePrivacySettings();
  const { data: profile } = useProfile();
  const httpScope = useHttpRequestScope();
  return useQuery({
    queryKey: httpScopeQueryKey(['profilePrivacy', profile?.id, settings?.privacyRevision, userId], httpScope),
    queryFn: async ({ signal }) => {
      const response = await getHttpClient(httpScope).request<{
        publicProfile: { isPrivate: boolean; canViewActivity: boolean } | null;
      }>({
        document: GET_PROFILE_PRIVACY,
        variables: { userId },
        signal,
      });
      assertCurrentHttpResult(httpScope, response);
      return response.publicProfile;
    },
    enabled: !!settings && !!userId,
  });
}
