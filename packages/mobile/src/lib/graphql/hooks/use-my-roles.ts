// The viewer's community roles, reduced to what authorization needs.
//
// The moderation feed mixes boards ("All boards" is a real filter), so a single
// "can I moderate?" boolean would be wrong on half the rows. The rows are handed
// the role list and each card answers for its own board type via
// `rolesGrantAdminOrLeader` — the same pure rule the backend resolvers use, so
// the buttons the client offers and the ones the server accepts can't drift.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GET_MY_ROLES, type GetMyRolesResponse } from '@boardsesh/graphql/operations/proposals';
import type { CommunityRoleScope } from '@boardsesh/community-roles';
import { getHttpClient } from '../client';
import { useAuthToken } from '../use-auth-token';

export const MY_ROLES_QUERY_KEY = ['myRoles'] as const;

/** Roles are granted by hand and effectively never change mid-session. */
const MY_ROLES_STALE_TIME_MS = 5 * 60 * 1000;

// Module-level so the "no roles" answer keeps one identity: it is a dep of the
// memoized card list, and a fresh `[]` every render would re-render every row.
const NO_ROLES: readonly CommunityRoleScope[] = [];

/**
 * The viewer's role rows, or an empty list when signed out or when the query
 * fails. Failing to an empty list is the safe direction: the moderator actions
 * stay hidden and the server rejects them anyway.
 */
export function useMyRoles(): readonly CommunityRoleScope[] {
  const { data: authToken } = useAuthToken();

  const { data } = useQuery({
    queryKey: MY_ROLES_QUERY_KEY,
    queryFn: async () => {
      const response = await getHttpClient().request<GetMyRolesResponse>(GET_MY_ROLES);
      return response.myRoles;
    },
    enabled: !!authToken,
    // One retry, not the default three: an older backend without `myRoles`
    // returns a schema error that will never succeed, and three round trips of
    // it delay nothing but the moderator buttons.
    retry: 1,
    staleTime: MY_ROLES_STALE_TIME_MS,
  });

  // `boardType` is optional on the wire and required by the rule (null = global),
  // so normalise once here rather than at every card.
  return useMemo(
    () => data?.map((assignment) => ({ role: assignment.role, boardType: assignment.boardType ?? null })) ?? NO_ROLES,
    [data],
  );
}
