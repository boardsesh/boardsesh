import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useToast } from '../../providers/toast-provider';
import { reportError } from '../error-reporting';
import { activatePublishedSprayWall } from './activate-published-spray-wall';

/**
 * Make a wall the active board by its uuid: an archived wall picked from My
 * Boards, or the wall that replaced an archived one.
 *
 * Neither is in the caller's hands as a full board row (`myBoards` leaves
 * archived walls out, and the replacement is only a uuid), so the row is read
 * fresh first. `activate` binds it: `useActivateBoard` where the boards modal
 * should close afterwards, `useSetActiveBoard` where the climber stays put.
 * One open at a time; a second tap while one is in flight is dropped.
 */
export function useOpenSprayWall(activate: (board: UserBoard) => Promise<void>) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useTranslation('boards');
  const inFlightRef = useRef(false);
  return useCallback(
    async (wallUuid: string): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        await activatePublishedSprayWall(queryClient, wallUuid, activate);
      } catch (error) {
        reportError(error);
        showToast(t('sprayArchive.openFailed'), 'error');
      } finally {
        inFlightRef.current = false;
      }
    },
    [queryClient, activate, showToast, t],
  );
}
