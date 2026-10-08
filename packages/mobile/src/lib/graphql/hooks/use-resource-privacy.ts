import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_RESOURCE_ACCESS_REQUESTS,
  APPROVE_RESOURCE_ACCESS,
  REVOKE_RESOURCE_ACCESS,
  REQUEST_RESOURCE_ACCESS,
  INVITE_RESOURCE_MEMBER,
  GET_CONTENT_AUDIENCE,
  GET_RESOURCE_PRIVACY,
  UPDATE_RESOURCE_PRIVACY,
  type PrivacyContentAudience,
  type PrivacyContentType,
  type ResourcePrivacySettings,
} from '@boardsesh/graphql/operations/privacy';
import { getHttpClient } from '../client';
import { useProfile } from './index';
import { usePrivacySettings } from './use-privacy';
import { invalidatePrivacyQueries } from '../../privacy/privacy-cache';
import { getConnectivitySnapshot } from '../../connectivity/connectivity-store';

export function useContentAudience(entityType: PrivacyContentType, entityId?: string) {
  const { data: settings } = usePrivacySettings();
  const { data: profile } = useProfile();
  return useQuery({
    queryKey: ['contentAudience', profile?.id, settings?.privacyRevision, entityType, entityId],
    queryFn: async ({ signal }) =>
      (
        await getHttpClient().request<{ contentAudience: PrivacyContentAudience }>({
          document: GET_CONTENT_AUDIENCE,
          variables: { entityType, entityId },
          signal,
        })
      ).contentAudience,
    enabled: settings?.enabled === true && !!entityId,
  });
}

export function useResourcePrivacy(kind: 'board' | 'session', resourceId?: string) {
  const { data: settings } = usePrivacySettings();
  const { data: profile } = useProfile();
  return useQuery({
    queryKey: ['resourcePrivacy', profile?.id, settings?.privacyRevision, kind, resourceId],
    queryFn: async ({ signal }) =>
      (
        await getHttpClient().request<{ resourcePrivacy: ResourcePrivacySettings | null }>({
          document: GET_RESOURCE_PRIVACY,
          variables: { kind, resourceId },
          signal,
        })
      ).resourcePrivacy,
    enabled: settings?.enabled === true && !!resourceId,
  });
}

export function useUpdateResourcePrivacy() {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async (
      input: Pick<ResourcePrivacySettings, 'kind' | 'resourceId' | 'audience'> &
        Partial<Pick<ResourcePrivacySettings, 'locationAudience' | 'inheritFollowers'>>,
    ) => {
      if (getConnectivitySnapshot().effectiveOffline) throw new Error('Privacy changes require a connection.');
      return (
        await getHttpClient().request<{ updateResourcePrivacy: ResourcePrivacySettings }>(UPDATE_RESOURCE_PRIVACY, {
          input,
        })
      ).updateResourcePrivacy;
    },
    onSuccess: () => invalidatePrivacyQueries(queryClient),
  });
}

export type ResourceGrant = {
  userId: string;
  status: 'pending' | 'approved' | 'revoked';
  invitedBy: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};
export function useResourceAccessRequests(kind: 'board' | 'session', resourceId: string, enabled: boolean) {
  const { data: profile } = useProfile();
  return useQuery({
    queryKey: ['resourceAccessRequests', profile?.id, kind, resourceId],
    queryFn: async ({ signal }) =>
      (
        await getHttpClient().request<{ resourceAccessRequests: ResourceGrant[] }>({
          document: GET_RESOURCE_ACCESS_REQUESTS,
          variables: { kind, resourceId },
          signal,
        })
      ).resourceAccessRequests,
    enabled: enabled && !!resourceId,
  });
}
const RESOURCE_ACTIONS = {
  request: REQUEST_RESOURCE_ACCESS,
  approve: APPROVE_RESOURCE_ACCESS,
  revoke: REVOKE_RESOURCE_ACCESS,
  invite: INVITE_RESOURCE_MEMBER,
};
export function useResourceAccessAction() {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async ({
      action,
      ...variables
    }: {
      action: keyof typeof RESOURCE_ACTIONS;
      kind: 'board' | 'session';
      resourceId: string;
      userId?: string;
    }) => {
      if (getConnectivitySnapshot().effectiveOffline) throw new Error('Privacy changes require a connection.');
      return getHttpClient().request(RESOURCE_ACTIONS[action], variables);
    },
    onSuccess: () => invalidatePrivacyQueries(queryClient),
  });
}
