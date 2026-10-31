import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectNewsEmailConsent, ProjectNewsEmailSource } from '@boardsesh/shared-schema';
import {
  GET_MY_PROJECT_NEWS_EMAIL_CONSENT,
  SET_PROJECT_NEWS_EMAIL_CONSENT,
  type GetMyProjectNewsEmailConsentResponse,
  type SetProjectNewsEmailConsentResponse,
} from '@boardsesh/graphql/operations/project-news-email';
import { getHttpClient } from '../client';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../../auth-store';
import { getConnectivitySnapshot } from '../../connectivity/connectivity-store';
import { useProfile } from './index';

const projectNewsEmailKey = (viewerId: string | undefined) => ['projectNewsEmailConsent', viewerId] as const;

function currentSource(): ProjectNewsEmailSource {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/** The signed-in climber's "Email me project news" answer. Never answered reads as off. */
export function useProjectNewsEmailConsent(enabled: boolean) {
  const { data: profile } = useProfile({ enabled });
  return useQuery({
    queryKey: projectNewsEmailKey(profile?.id),
    queryFn: async ({ signal }) => {
      const response = await getHttpClient().request<GetMyProjectNewsEmailConsentResponse>({
        document: GET_MY_PROJECT_NEWS_EMAIL_CONSENT,
        signal,
      });
      return response.myProjectNewsEmailConsent;
    },
    enabled: enabled && !!profile?.id,
    staleTime: 30_000,
  });
}

type ViewerScope = { viewerId: string | undefined; credentialGeneration: number };

/**
 * Flip the switch. Online only: a consent answer is recorded by the server at
 * the moment it lands, so it is never queued for later. The write is bound to
 * the account that was signed in at the tap; a sign-out or account switch
 * before it lands refuses it rather than writing to the new account.
 */
export function useSetProjectNewsEmailConsent() {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const latestViewerId = useRef(profile?.id);
  latestViewerId.current = profile?.id;
  const requireScope = (scope: ViewerScope) => {
    if (
      !scope.viewerId ||
      latestViewerId.current !== scope.viewerId ||
      !isAuthCredentialGenerationCurrent(scope.credentialGeneration)
    ) {
      throw new Error('Email settings changes require the same signed-in account.');
    }
  };
  const mutation = useMutation<ProjectNewsEmailConsent, Error, { subscribed: boolean; scope: ViewerScope }>({
    networkMode: 'always',
    mutationFn: async ({ subscribed, scope }) => {
      if (getConnectivitySnapshot().effectiveOffline) throw new Error('Email settings changes require a connection.');
      requireScope(scope);
      const response = await getHttpClient().request<SetProjectNewsEmailConsentResponse>(
        SET_PROJECT_NEWS_EMAIL_CONSENT,
        { input: { subscribed, source: currentSource() } },
      );
      requireScope(scope);
      return response.setProjectNewsEmailConsent;
    },
    onSuccess: (consent, { scope }) => {
      queryClient.setQueryData(projectNewsEmailKey(scope.viewerId), consent);
    },
  });
  const { mutate: mutateWithScope } = mutation;
  // Stable across renders, so a screen can list it in a memo's deps.
  const mutate = useCallback(
    (subscribed: boolean) =>
      mutateWithScope({
        subscribed,
        scope: { viewerId: latestViewerId.current, credentialGeneration: captureAuthCredentialGeneration() },
      }),
    [mutateWithScope],
  );
  return {
    isPending: mutation.isPending,
    isError: mutation.isError,
    /** The value being saved, while a save is in flight. */
    pendingValue: mutation.isPending ? mutation.variables?.subscribed : undefined,
    reset: mutation.reset,
    mutate,
  };
}
