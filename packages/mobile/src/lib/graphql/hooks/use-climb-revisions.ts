import { useQuery } from '@tanstack/react-query';
import {
  GET_CLIMB_REVISIONS,
  type ClimbRevisionRow,
  type GetClimbRevisionsQueryResponse,
  type GetClimbRevisionsQueryVariables,
} from '@boardsesh/graphql/operations/climb-revisions';
import { getHttpClient } from '../client';
import { climbRevisionsQueryKey } from './climb-revisions-query-key';

export type { ClimbRevisionRow };

/**
 * How a climb has been edited since it was published, newest first.
 *
 * Network only, and not persisted: the rows live on the server alone
 * (`board_climb_revisions` is not synced to the device), so with no connection
 * the query stays pending and the section that reads it renders nothing
 * (`docs/offline-reads.md`).
 *
 * An empty list is the normal answer: a climb nobody has edited, a draft, and a
 * spray climb on a wall the viewer cannot see all return `[]`. The server caps
 * the list at `MAX_REVISIONS_PER_CLIMB`, so there is no pagination.
 */
export function useClimbRevisions(boardType: string, climbUuid: string, enabled = true) {
  return useQuery({
    queryKey: climbRevisionsQueryKey(boardType, climbUuid),
    queryFn: () =>
      getHttpClient().request<GetClimbRevisionsQueryResponse, GetClimbRevisionsQueryVariables>(GET_CLIMB_REVISIONS, {
        boardType,
        climbUuid,
      }),
    select: (response) => response.climbRevisions,
    enabled: enabled && !!climbUuid,
    staleTime: 5 * 60 * 1000,
  });
}
