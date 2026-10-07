import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { useDeleteClimb } from '../../lib/graphql/hooks/use-delete-climb';
import { getConnectivitySnapshot } from '../../lib/connectivity/connectivity-store';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { deleteClimbErrorMessage, deleteClimbRefusal } from './delete-climb-rules';

/**
 * The delete flow behind the row: an offline refusal, a confirm, the mutation,
 * and a toast either way. `onDeleted` runs after a successful delete, which is
 * where a surface showing the climb (the play drawer) closes itself.
 */
export function useDeleteClimbAction(): (
  climb: Pick<Climb, 'uuid'>,
  boardName: string,
  onDeleted?: () => void,
) => Promise<void> {
  const { t } = useTranslation('climbs');
  const confirm = useConfirm();
  const { showToast } = useToast();
  const { mutateAsync } = useDeleteClimb();
  // A double tap must not stack two dialogs or send the delete twice.
  const inFlight = useRef(false);

  return useCallback(
    async (climb, boardName, onDeleted) => {
      if (inFlight.current) return;
      // Never queued: a delete waiting in the outbox could land after somebody
      // ticked the climb. Say so instead of sending a request that cannot land.
      if (getConnectivitySnapshot().effectiveOffline) {
        showToast(t('mobile.climbActions.deleteClimb.offline'), 'error');
        return;
      }
      inFlight.current = true;
      try {
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
        inFlight.current = false;
      }
    },
    [confirm, mutateAsync, showToast, t],
  );
}
