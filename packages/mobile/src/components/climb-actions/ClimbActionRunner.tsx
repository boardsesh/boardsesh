import { useCallback, useEffect, useRef } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { BoardConfig, OpenClimbActionsOptions } from '../../providers/drawer-host-provider';
import { useFavoriteStatus } from '../../lib/graphql/hooks';
import type { ClimbActionId } from './climb-action-gating';
import { useClimbActions } from './use-climb-actions';

export type ClimbActionRunRequest = {
  /** Bumped per pick, so a second pick on the same climb remounts the runner. */
  nonce: number;
  actionId: ClimbActionId;
  climb: Climb;
  boardConfig: BoardConfig;
  options?: OpenClimbActionsOptions;
};

type ClimbActionRunnerProps = {
  request: ClimbActionRunRequest;
  currentUserId: string | null;
  isAuthenticated: boolean;
  /** The action finished handing off (its `onAfterAction`). Unmounts the runner. */
  onDone: (nonce: number) => void;
  /** Show the reaction overlay instead: for the playlist picker it hosts, or when
   *  the picked action is no longer offered by the time it runs. */
  onShowOverlay: (request: ClimbActionRunRequest, initialView: 'menu' | 'playlist') => void;
};

/**
 * Runs one action picked in the iOS native context menu, then unmounts. Renders
 * nothing. It builds the action list with the same hook and the same options the
 * reaction overlay uses, so a native-menu pick and an overlay tap run identical
 * code: the same sheets, the same in-tree openers over `/play`, the same
 * analytics.
 */
export function ClimbActionRunner({
  request,
  currentUserId,
  isAuthenticated,
  onDone,
  onShowOverlay,
}: ClimbActionRunnerProps) {
  const { nonce, actionId, climb, boardConfig, options } = request;

  const handleAfterAction = useCallback(() => onDone(nonce), [onDone, nonce]);
  const requestRef = useRef(request);
  requestRef.current = request;
  const handleSelectPlaylist = useCallback(() => onShowOverlay(requestRef.current, 'playlist'), [onShowOverlay]);

  const actions = useClimbActions({
    climb,
    boardConfig,
    queueItemUuid: options?.queueItemUuid,
    currentUserId,
    isAuthenticated,
    onEditEntry: options?.onEditEntry,
    onAfterAction: handleAfterAction,
    onSelectPlaylist: handleSelectPlaylist,
    onAddBetaVideo: options?.onAddBetaVideo,
    onTick: options?.onTick,
    onReportClimb: options?.onReportClimb,
    onOpenQueue: options?.onOpenQueue,
    dismissSourceSheet: options?.dismissSourceSheet,
    dismissPlayerAndWait: options?.dismissPlayerAndWait,
  });

  // The favourite toggle writes the opposite of the climb's current state, so it
  // waits for that state. The overlay reads the same query (shared cache key);
  // here nobody can tap before it lands, so wait for it explicitly.
  const { isLoading: favoriteLoading } = useFavoriteStatus(boardConfig.boardName, climb.uuid, boardConfig.angle, {
    enabled: actionId === 'favorite',
  });
  const ready = actionId !== 'favorite' || !favoriteLoading;

  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current || !ready) return;
    ranRef.current = true;
    const action = actions.find((item) => item.id === actionId);
    if (action) {
      action.run();
      return;
    }
    // The menu offered it, but the gate moved under it (the climb went on the
    // wall, an edit window closed). Show the full menu rather than do nothing.
    onShowOverlay(requestRef.current, 'menu');
  }, [actions, actionId, ready, onShowOverlay]);

  return null;
}
