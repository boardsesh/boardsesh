import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useDeleteClimb } from '../../lib/graphql/hooks/use-delete-climb';
import { useHttpActionScope } from '../../lib/graphql/use-http-action-scope';
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
 * The dialog and toasts are app-level, so on native the flow finishes what the
 * climber started even if the calling component unmounts, and stops only when
 * the account changes. `onDeleted` is the component's own follow-up and runs
 * only while it is mounted. In a browser view the flow stops with the component,
 * so a menu host that unmounts on close takes the flow from an owner that
 * outlives it.
 */
export function useDeleteClimbAction(): RequestDeleteClimb {
  const { t } = useTranslation('climbs');
  const confirm = useConfirm();
  const { showToast } = useToast();
  const { mutateWithReceipt } = useDeleteClimb();
  const { capture: captureAction } = useHttpActionScope();
  // A double tap must not stack two dialogs or send the delete twice. Per
  // climb: one owner can run every row menu, and another climb's Delete is a
  // separate request.
  const inFlight = useRef(new Map<string, ReturnType<typeof captureAction>>());

  return useCallback(
    async (climb, boardName, onDeleted) => {
      if (inFlight.current.get(climb.uuid)?.isOwnerCurrent()) return;
      let action: ReturnType<typeof captureAction>;
      try {
        action = captureAction();
      } catch {
        return;
      }
      inFlight.current.set(climb.uuid, action);
      try {
        // Never queued: a delete waiting in the outbox could land after somebody
        // ticked the climb. Say so instead of sending a request that cannot land.
        if (getConnectivitySnapshot().effectiveOffline) {
          action.assertOwner();
          showToast(t('mobile.climbActions.deleteClimb.offline'), 'error');
          return;
        }
        // A send of the climber's own still waiting in the outbox is a tick the
        // server cannot see yet. Deleting now would win the race and strand it.
        const pendingTick = await hasQueuedTickForClimb(climb.uuid);
        action.assertOwner();
        if (pendingTick) {
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
        action.assertOwner();
        if (!confirmed) return;
        const receipt = await mutateWithReceipt(
          { uuid: climb.uuid, boardType: boardName },
          { signal: action.signal },
        ).catch((error: unknown) => {
          if (action.isOwnerCurrent() && !(error instanceof BrowserBackendConsumerError))
            showToast(deleteClimbErrorMessage(deleteClimbRefusal(error), t), 'error');
          return null;
        });
        if (!receipt) return;
        action.assertOwner();
        receipt.assertCurrent();
        showToast(t('mobile.climbActions.deleteClimb.success'), 'success');
        action.assertView();
        receipt.assertCurrent();
        onDeleted?.();
      } catch (error) {
        if (action.isOwnerCurrent() && !(error instanceof BrowserBackendConsumerError)) throw error;
      } finally {
        action.finish();
        if (inFlight.current.get(climb.uuid) === action) inFlight.current.delete(climb.uuid);
      }
    },
    [captureAction, confirm, mutateWithReceipt, showToast, t],
  );
}
