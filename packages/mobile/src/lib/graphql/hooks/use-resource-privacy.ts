import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { refreshAfterOwnPrivacyChange } from '../../privacy/privacy-cache';
import { getConnectivitySnapshot } from '../../connectivity/connectivity-store';
import { screenshotModeNextPageParam } from '../../screenshot-mode';

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
    onSuccess: () => refreshAfterOwnPrivacyChange(queryClient),
  });
}

export type ResourceGrant = {
  userId: string;
  status: 'pending' | 'approved' | 'revoked';
  invitedBy: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};
/** The server's page size for the access list (`resourceAccessRequests`). */
const ACCESS_LIST_PAGE_SIZE = 100;
type ResourceKind = 'board' | 'session';

async function requestResourceGrants(
  variables: { kind: ResourceKind; resourceId: string; offset?: number; userIds?: string[] },
  signal: AbortSignal,
): Promise<ResourceGrant[]> {
  return (
    await getHttpClient().request<{ resourceAccessRequests: ResourceGrant[] }>({
      document: GET_RESOURCE_ACCESS_REQUESTS,
      variables,
      signal,
    })
  ).resourceAccessRequests;
}

/**
 * The owner's access list: pending requests first, then members, newest first,
 * a page at a time. A share link lets anyone holding it join, so the list can
 * run past one page.
 */
export function useResourceAccessRequests(kind: ResourceKind, resourceId: string, enabled: boolean) {
  const { data: profile } = useProfile();
  return useInfiniteQuery({
    queryKey: ['resourceAccessRequests', profile?.id, kind, resourceId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => requestResourceGrants({ kind, resourceId, offset: pageParam }, signal),
    getNextPageParam: (lastPage, allPages) =>
      screenshotModeNextPageParam(
        lastPage.length < ACCESS_LIST_PAGE_SIZE ? undefined : allPages.reduce((sum, page) => sum + page.length, 0),
        allPages.length,
      ),
    enabled: enabled && !!resourceId,
  });
}

type GrantStatusResult = { data?: ResourceGrant[]; isSuccess: boolean; isError: boolean };

/** Module scope keeps its identity, so `useQueries` can hand back the same value when nothing changed. */
function combineGrantStatuses(results: GrantStatusResult[]) {
  return {
    grants: results.flatMap((result) => result.data ?? []),
    // A page's results are only shown once their grants are known; until then
    // a member would read as someone to invite.
    loadedPages: results.map((result) => result.isSuccess),
    isError: results.some((result) => result.isError),
  };
}

/**
 * The owner's grants for the people on each page of a search, whatever their
 * status, one request per page (pages are 30 people; the server takes 100).
 * Reading them from the access list instead would miss anyone past its first
 * page and offer to invite a member.
 */
export function useResourceGrantStatuses(
  kind: ResourceKind,
  resourceId: string,
  userIdPages: string[][],
  enabled: boolean,
) {
  const { data: profile } = useProfile();
  return useQueries({
    queries: userIdPages.map((userIds) => ({
      queryKey: ['resourceGrantStatuses', profile?.id, kind, resourceId, userIds],
      queryFn: ({ signal }: { signal: AbortSignal }) => requestResourceGrants({ kind, resourceId, userIds }, signal),
      enabled: enabled && !!resourceId && userIds.length > 0,
    })),
    combine: combineGrantStatuses,
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
    onSuccess: () => refreshAfterOwnPrivacyChange(queryClient),
  });
}
