import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBoardAdapter, useLogbook } from '@boardsesh/board-react';
import type { BoardName } from '@boardsesh/shared-schema';
import { ClimbProgressContext } from '../lib/climb-progress-context';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../lib/privacy/privacy-cache';
import { createClimbProgressStore, type ClimbProgressStore } from '../lib/climb-progress-store';
import { climbProgressCacheScopeFor } from '../lib/climb-progress-cache-owner';
import { useClimbRowField } from '../lib/climb-row-display-preference';

export type ClimbProgressTarget = { boardName: BoardName; climbUuid: string };
const noCredentialSubscription = () => () => {};

/** A supported list supplies one memoized UUID batch per board, never per row. */
export function ClimbProgressProvider({
  targets,
  enabled = true,
  children,
}: {
  targets: readonly ClimbProgressTarget[];
  enabled?: boolean;
  children: ReactNode;
}) {
  const showProgress = useClimbRowField('progress');
  const showSentMark = useClimbRowField('sentMark');
  const active = (showProgress || showSentMark) && enabled;
  // The wrapper stays mounted when the switch changes. Disabled lists need no
  // auth/query adapter, and subscribe to no credential events.
  const generation = useSyncExternalStore(
    active ? subscribeToCredentialChanges : noCredentialSubscription,
    getCredentialGeneration,
    getCredentialGeneration,
  );
  const store = useMemo(() => createClimbProgressStore(generation, getCredentialGeneration), [generation]);
  useLayoutEffect(() => {
    if (!active) store.clear();
  }, [active, store]);
  useEffect(
    () =>
      active
        ? subscribeToCredentialChanges(() => {
            if (generation !== getCredentialGeneration()) store.clear();
          })
        : undefined,
    [active, generation, store],
  );
  return (
    <ClimbProgressContext.Provider value={store}>
      {active ? (
        <ProgressScopeLoaders key={generation} generation={generation} targets={targets} store={store} />
      ) : null}
      {children}
    </ClimbProgressContext.Provider>
  );
}

function ProgressScopeLoaders({
  generation,
  targets,
  store,
}: {
  generation: number;
  targets: readonly ClimbProgressTarget[];
  store: ClimbProgressStore;
}) {
  const queryClient = useQueryClient();
  climbProgressCacheScopeFor(queryClient);
  const { isAuthenticated, isAuthLoading: isLoading } = useBoardAdapter();
  const batches = useMemo(() => {
    const byBoard = new Map<BoardName, Set<string>>();
    for (const target of targets) {
      const uuids = byBoard.get(target.boardName) ?? new Set<string>();
      uuids.add(target.climbUuid);
      byBoard.set(target.boardName, uuids);
    }
    return [...byBoard].map(([boardName, uuids]) => ({ boardName, climbUuids: [...uuids] }));
  }, [targets]);
  useLayoutEffect(() => {
    if (!isAuthenticated || isLoading) store.clear();
  }, [isAuthenticated, isLoading, store]);
  return isAuthenticated && !isLoading ? (
    <>
      {batches.map((batch) => (
        <BoardProgressBatch key={batch.boardName} {...batch} generation={generation} store={store} />
      ))}
    </>
  ) : null;
}

const BoardProgressBatch = memo(function BoardProgressBatch({
  boardName,
  climbUuids,
  generation,
  store,
}: {
  boardName: BoardName;
  climbUuids: string[];
  generation: number;
  store: ClimbProgressStore;
}) {
  const queryClient = useQueryClient();
  const scope = climbProgressCacheScopeFor(queryClient);
  const subscribe = useCallback(
    (listener: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type === 'removed') listener();
      }),
    [queryClient],
  );
  const snapshot = useCallback(() => scope.belongsToCurrentScope(boardName), [scope, boardName]);
  const belongsToScope = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { logbook } = useLogbook(belongsToScope ? boardName : null, climbUuids);
  // A cache removal changes useLogbook's accumulated observer, so an old query
  // identity becomes a fresh board query without a separate volatile context.
  useLayoutEffect(() => {
    if (generation !== getCredentialGeneration() || !scope.belongsToCurrentScope(boardName)) return;
    store.publish(boardName, logbook);
  }, [boardName, logbook, generation, scope, store]);
  return null;
});
