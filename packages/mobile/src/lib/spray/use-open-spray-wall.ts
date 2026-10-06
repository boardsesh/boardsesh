import { useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
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
 *
 * A failure is said with a system alert, never a toast: both callers sit in
 * front of the toast overlay (the Boards modal route and the native board
 * sheet), which would hide it. Resolves whether the wall was opened.
 */
export function useOpenSprayWall(activate: (board: UserBoard) => Promise<void>) {
  const queryClient = useQueryClient();
  const { t } = useTranslation('boards');
  const inFlightRef = useRef(false);
  return useCallback(
    async (wallUuid: string): Promise<boolean> => {
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      try {
        await activatePublishedSprayWall(queryClient, wallUuid, activate);
        return true;
      } catch (error) {
        reportError(error);
        Alert.alert(t('sprayArchive.openFailed'));
        return false;
      } finally {
        inFlightRef.current = false;
      }
    },
    [queryClient, activate, t],
  );
}
