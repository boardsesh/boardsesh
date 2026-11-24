import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import { assertLocalUserDataOwner, parseOfflineBoardKey } from '@boardsesh/offline-sync';
import { getDatabaseHandle } from '../../db';
import {
  getClimbPlaysLocal,
  type LocalPlaysRow,
  type LocalPlaysScope,
  type LocalPlaysTarget,
} from '../../db/queries/get-climb-plays-local';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { usePrivacyCredentialScope } from '../../hooks/use-privacy-scoped-state';
import { useDownloadedScopeKeys } from '../../offline/use-downloaded-scope-keys';
import { useSetting } from '../../settings';
import { getCredentialGeneration } from '../privacy/privacy-cache';
import { climbPlayCountKey, type ClimbPlaysProjection } from '../climb-play-count';

export type PlaylistLocalPlaysTarget = LocalPlaysScope & LocalPlaysTarget;
type PlaysGroup = { scope: LocalPlaysScope; targets: LocalPlaysTarget[]; scopeKeys: string[] };
type GroupPlays = { scope: LocalPlaysScope; rows: LocalPlaysRow[]; credentialScope: number };

function indexCounts(results: UseQueryResult<GroupPlays>[]): ReadonlyMap<string, ClimbPlaysProjection> {
  const counts = new Map<string, ClimbPlaysProjection>();
  for (const { data } of results) {
    if (!data) continue;
    const { boardName, layoutId } = data.scope;
    for (const { climbUuid, angle, playCount } of data.rows) {
      counts.set(climbPlayCountKey(boardName, layoutId, climbUuid, angle), {
        credentialScope: data.credentialScope,
        authority: boardName === 'spray' ? 'wall' : 'reference',
        playCount,
      });
    }
  }
  return counts;
}

async function readPlaysGroup(
  { scope, targets, scopeKeys }: PlaysGroup,
  credentialScope: number,
  expectedOwner: string | null,
): Promise<GroupPlays> {
  const empty = { scope, rows: [], credentialScope };
  const db = getDatabaseHandle();
  if (!db || getCredentialGeneration() !== credentialScope) return empty;
  const { readLocalUserId } = await import('../local-user-id');
  const viewer = (await readLocalUserId()) ?? null;
  if (viewer !== expectedOwner) return empty;
  const ownership = await assertLocalUserDataOwner(db, viewer);
  if (ownership === 'mismatch' || (scope.boardName === 'spray' && ownership !== 'ok')) return empty;
  if (getCredentialGeneration() !== credentialScope) return empty;
  const rows = await getClimbPlaysLocal(db, scope, targets, scopeKeys, viewer);
  return getCredentialGeneration() === credentialScope && getDatabaseHandle() === db
    ? { scope, rows, credentialScope }
    : empty;
}

/** Playlist rows with another payload angle share one local read per board/layout. */
export function usePlaylistLocalPlays(
  targets: readonly PlaylistLocalPlaysTarget[],
): ReadonlyMap<string, ClimbPlaysProjection> {
  const credentialScope = usePrivacyCredentialScope();
  const { userId, isLoading } = useStoredUserId(targets.length > 0);
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  const groups = useMemo(() => {
    if (!downloadedScopeKeys?.length || targets.length === 0) return [];
    const scopeKeysByLayout = new Map<string, string[]>();
    const downloaded = new Set(downloadedScopeKeys);
    for (const scopeKey of enabledScopeKeys) {
      if (!downloaded.has(scopeKey)) continue;
      const scope = parseOfflineBoardKey(scopeKey);
      if (!scope) continue;
      const layoutKey = JSON.stringify([scope.boardType, scope.layoutId]);
      const scopeKeys = scopeKeysByLayout.get(layoutKey) ?? [];
      scopeKeys.push(scopeKey);
      scopeKeysByLayout.set(layoutKey, scopeKeys);
    }
    const grouped = new Map<string, PlaysGroup>();
    for (const { boardName, layoutId, climbUuid, angle } of targets) {
      const layoutKey = JSON.stringify([boardName, layoutId]);
      const scopeKeys = scopeKeysByLayout.get(layoutKey);
      if (!scopeKeys) continue;
      const group = grouped.get(layoutKey) ?? { scope: { boardName, layoutId }, targets: [], scopeKeys };
      group.targets.push({ climbUuid, angle });
      grouped.set(layoutKey, group);
    }
    return [...grouped.values()];
  }, [downloadedScopeKeys, enabledScopeKeys, targets]);
  return useQueries({
    queries: groups.map((group) => ({
      queryKey: ['playlistLocalPlays', group.scope, credentialScope, userId ?? null, group.scopeKeys, group.targets],
      queryFn: () => readPlaysGroup(group, credentialScope, userId ?? null),
      enabled: !isLoading,
      networkMode: 'always' as const,
    })),
    combine: indexCounts,
  });
}
