import { useQuery } from '@tanstack/react-query';
import { getDatabaseHandle } from '../db';
import { CLIMB_QUERY_KEY } from '../lib/graphql/query-keys';
import { readClimbRevisionNumbersLocal, type LocalClimbRevisionNumbers } from '../db/queries/climb-revisions-local';

/**
 * Under the `['climb', climbUuid]` prefix, so the invalidations a climb edit
 * and a board pull already fire for the climb's detail cache reach this too.
 */
export function localClimbRevisionQueryKey(boardName: string, climbUuid: string) {
  return [...CLIMB_QUERY_KEY, climbUuid, 'localRevision', boardName] as const;
}

/**
 * The version numbers the phone's own copy of a climb holds (#6023), for a
 * climb that reached the screen without them.
 *
 * That is every climb that has been through a shared queue: the queue
 * documents are pinned by the screenshot fixtures and cannot select
 * `revisionNumber`, so a peer's echo hands the climb back without it. The
 * numbers are board catalogue data, not a climber's own rows, so there is no
 * owner to check before serving them.
 *
 * Pass `enabled: false` when the climb already carries its numbers; the hook
 * then reads nothing. Resolves undefined while loading, when the board is not
 * on the phone, or when the phone's row predates the columns.
 */
export function useLocalClimbRevision(
  boardName: string | null | undefined,
  climbUuid: string | null | undefined,
  enabled: boolean,
): LocalClimbRevisionNumbers | undefined {
  const wanted = enabled && !!boardName && !!climbUuid;
  const { data } = useQuery({
    queryKey: localClimbRevisionQueryKey(boardName ?? '', climbUuid ?? ''),
    enabled: wanted,
    // A local read must not wait on the network.
    networkMode: 'always',
    staleTime: Infinity,
    queryFn: async (): Promise<LocalClimbRevisionNumbers | null> => {
      const db = getDatabaseHandle();
      if (!db || !boardName || !climbUuid) return null;
      const numbersByClimb = await readClimbRevisionNumbersLocal(db, boardName, [climbUuid]);
      return numbersByClimb.get(climbUuid) ?? null;
    },
  });
  return wanted ? (data ?? undefined) : undefined;
}
