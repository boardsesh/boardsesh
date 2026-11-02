import type { ClimbActionsTarget, BoardConfig } from '../../providers/drawer-host-provider';
import type { Climb } from '@boardsesh/shared-schema';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import { reportHandledError } from '../../lib/error-reporting';

type PinnedOpener = (climb: Climb, board: BoardConfig, source?: Pick<ClimbActionsTarget, 'queueItemUuid'>) => void;
export type ClimbActionPresenters = {
  tick: PinnedOpener;
  beta: PinnedOpener;
  report: PinnedOpener;
  playlist: PinnedOpener;
};
let playerPresenters: ClimbActionPresenters | null = null;

/** The modal player owns the sheets that must present above its native route. */
export function registerClimbActionPresenters(presenters: ClimbActionPresenters): () => void {
  playerPresenters = presenters;
  return () => {
    if (playerPresenters === presenters) playerPresenters = null;
  };
}
export function getClimbActionPresenters(): ClimbActionPresenters | null {
  return playerPresenters;
}

export function openPresentedClimbAction(
  presenters: ClimbActionPresenters,
  action: keyof ClimbActionPresenters,
  target: ClimbActionsTarget,
): void {
  const credentialGeneration = getCredentialGeneration();
  const open = async () => {
    if (target.dismissSourceSheet) {
      const result = await target.dismissSourceSheet();
      if (result.status === 'aborted') return;
    }
    // Dismissing the source sheet can outlive the player route itself.
    if (playerPresenters !== presenters || credentialGeneration !== getCredentialGeneration()) return;
    if (action === 'tick') presenters.tick(target.climb, target.boardConfig, { queueItemUuid: target.queueItemUuid });
    else presenters[action](target.climb, target.boardConfig);
  };
  void open().catch((error: unknown) =>
    reportHandledError(error, {
      tags: { source: 'climb-menu', op: 'present' },
    }),
  );
}
