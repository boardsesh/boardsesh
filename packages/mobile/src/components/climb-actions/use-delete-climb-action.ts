import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { useDeleteClimb } from '../../lib/graphql/hooks/use-delete-climb';
import { getConnectivitySnapshot } from '../../lib/connectivity/connectivity-store';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { hasQueuedTickForClimb } from '../../offline/pending-tick';
import { deleteClimbErrorMessage, deleteClimbRefusal } from './delete-climb-rules';

export type RequestDeleteClimb = (
  climb: Pick<Climb, 'uuid'>,
  boardName: string,
  onDeleted?: () => void,
) => Promise<void>;

/**
 * The delete flow behind the row: an offline refusal, a confirm, the mutation,
 * and a toast either way. `onDeleted` runs after a successful delete, which is
 * where a surface showing the climb (the play drawer) closes itself.
 *
 * The dialog and toasts are app-level, so the flow finishes what the climber
 * started even if the calling component unmounts. A row menu's host unmounts
 * when the menu closes, so the root provider owns one flow for every row.
 */
export function useDeleteClimbAction(): RequestDeleteClimb {
  const { t } = useTranslation('climbs');
  const confirm = useConfirm();
  const { showToast } = useToast();
  const { mutateAsync } = useDeleteClimb();
  // A double tap must not stack two dialogs or send the delete twice. Per
  // climb: one owner can run every row menu, and another climb's Delete is a
  // separate request.
  const inFlight = useRef(new Set<string>());

  return useCallback(
    async (climb, boardName, onDeleted) => {
      if (inFlight.current.has(climb.uuid)) return;
      // Never queued: a delete waiting in the outbox could land after somebody
      // ticked the climb. Say so instead of sending a request that cannot land.
      if (getConnectivitySnapshot().effectiveOffline) {
        showToast(t('mobile.climbActions.deleteClimb.offline'), 'error');
        return;
      }
      inFlight.current.add(climb.uuid);
      try {
        // A send of the climber's own still waiting in the outbox is a tick the
        // server cannot see yet. Deleting now would win the race and strand it.
        if (await hasQueuedTickForClimb(climb.uuid)) {
          showToast(t('mobile.climbActions.deleteClimb.pendingTick'), 'error');
          return;
        }
        const confirmed = await confirm({
          title: t('mobile.climbActions.deleteClimb.title'),
          message: t('mobile.climbActions.deleteClimb.message'),
          confirmLabel: t('mobile.climbActions.deleteClimb.confirm'),
          cancelLabel: t('mobile.climbActions.deleteClimb.cancel'),
          destructive: true,
        });
        if (!confirmed) return;
        try {
          await mutateAsync({ uuid: climb.uuid, boardType: boardName });
        } catch (error) {
          showToast(deleteClimbErrorMessage(deleteClimbRefusal(error), t), 'error');
          return;
        }
        showToast(t('mobile.climbActions.deleteClimb.success'), 'success');
        onDeleted?.();
      } finally {
        inFlight.current.delete(climb.uuid);
      }
    },
    [confirm, mutateAsync, showToast, t],
  );
}
