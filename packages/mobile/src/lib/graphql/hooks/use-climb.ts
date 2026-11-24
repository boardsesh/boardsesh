import { useQuery } from '@tanstack/react-query';
import { usePrivacyCredentialScope } from '../../../hooks/use-privacy-scoped-state';
import { projectClimbPlays, type CatalogPlaysScope } from '../../climb-play-count';
import { getSprayWall } from '../../spray/spray-wall-registry';
import { offlineAwareRequest } from '../offline-request';
import { GET_CLIMB, GET_SPRAY_CLIMB, type GetClimbQueryResponse, type GetClimbQueryVariables } from '../operations';
import { CLIMB_QUERY_KEY } from '../query-keys';

function scopeClimbRead(variables: GetClimbQueryVariables | null): GetClimbQueryVariables | null {
  return variables?.boardName === 'spray'
    ? { ...variables, sprayWallUuid: variables.sprayWallUuid ?? getSprayWall(variables.layoutId)?.wallUuid }
    : variables;
}

function useClimbRead(variables: GetClimbQueryVariables | null, credentialScope: number) {
  return useQuery({
    queryKey: [...CLIMB_QUERY_KEY, variables, credentialScope],
    queryFn: () =>
      offlineAwareRequest<GetClimbQueryResponse>(
        variables?.boardName === 'spray' ? GET_SPRAY_CLIMB : GET_CLIMB,
        variables!,
      ),
    select: (response) => response.climb,
    enabled: !!variables,
  });
}

export function useClimb(variables: GetClimbQueryVariables | null) {
  return useClimbRead(scopeClimbRead(variables), usePrivacyCredentialScope());
}

/** Use the existing detail cache for the current drawer and the preview regrade. */
export function useSelectedClimbPlays(variables: GetClimbQueryVariables | null, readsPlays: boolean) {
  const credentialScope = usePrivacyCredentialScope();
  const scoped = scopeClimbRead(variables);
  const { data: climbAtAngle } = useClimbRead(scoped, credentialScope);
  if (!scoped || !readsPlays) return { climbAtAngle, catalogPlays: undefined };
  const { boardName, layoutId, angle, sprayWallUuid } = scoped;
  // This is the capability actually attached to the query, including for a
  // pending or denied exact read. The broad stats batch has no such grant.
  const scope: CatalogPlaysScope = { credentialScope, authority: sprayWallUuid ? 'wall' : 'reference' };
  const catalogPlays = projectClimbPlays(climbAtAngle, boardName, layoutId, angle, scope) ?? {
    ...scope,
    playCount: null,
  };
  return { climbAtAngle, catalogPlays };
}
