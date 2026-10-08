import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { useProfile } from './index';
import { getConnectivitySnapshot } from '../../connectivity/connectivity-store';
import { invalidatePrivacyQueries } from '../../privacy/privacy-cache';

export const PRIVACY_ONBOARDING_VERSION = 1;

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

export function useUpdatePrivacySettings() {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  return useMutation({
    networkMode: 'always',
    mutationFn: async (input: UpdatePrivacySettingsInput) => {
      requireConnected();
      const response = await getHttpClient().request<{ updatePrivacySettings: PrivacySettings }>(
        UPDATE_PRIVACY_SETTINGS,
        { input },
      );
      return response.updatePrivacySettings;
    },
    onSuccess: async (settings) => {
      await invalidatePrivacyQueries(queryClient);
      queryClient.setQueryData(['privacySettings', profile?.id], settings);
    },
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
    onSuccess: () => invalidatePrivacyQueries(queryClient),
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
    onSuccess: () => invalidatePrivacyQueries(queryClient),
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
