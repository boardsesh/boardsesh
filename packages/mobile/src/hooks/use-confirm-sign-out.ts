import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getPendingCount } from '@boardsesh/offline-sync';
import { useAuth } from '../providers/auth-provider';
import { useConfirm } from '../providers/dialog-provider';
import { getDatabaseHandle } from '../db';
import { hasDownloadedBoardData } from '../db/queries/board-download-status';
import { reportError } from '../lib/error-reporting';

/**
 * The manual sign-out flow: warn about what the wipe destroys, then run it.
 *
 * Sign-out is destructive in two ways a user can't see — purgeLocalDataForSignOut
 * deletes the downloaded board catalogs and the offline logbook, and discards any
 * writes still queued (issue #3621). Both entry points (the user drawer and the More
 * tab) go through here so the warning can't drift apart from one of them again; the
 * drawer used to sign out instantly with no confirmation at all.
 *
 * The confirm lives in this hook rather than in AuthProvider's `signOut` on purpose.
 * The forced paths — the interceptor's failed-refresh 401 and checkAuth's proactive
 * expiry — call runSignedOutCleanup directly, and account deletion calls
 * signOut('account_deleted') behind its own typed-DELETE gate. None of them has a
 * meaningful moment to ask (the token is already dead), so putting the dialog in the
 * provider would mean an opt-out flag on every one of them.
 */
export function useConfirmSignOut(): () => Promise<void> {
  const confirm = useConfirm();
  const { signOut } = useAuth();
  const { t } = useTranslation('common');
  // A double-tap must not stack two dialogs or two sign-outs. DialogProvider already
  // queues confirms and settles each once by id, but that would still mean two
  // dialogs; this is the guard that keeps it to one. Held only for the duration of
  // one flow (see the finally) so a cancel — or a sign-out that resolves without
  // navigating away — leaves the button usable for a retry.
  const inFlightRef = useRef(false);

  return useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const localDb = getDatabaseHandle();
      let pendingCount = 0;
      let hasDownloads = false;
      try {
        // No handle means offline storage failed to initialise this session, so
        // there is nothing local to lose. A read failure is not a reason to skip the
        // warning — fall back to "nothing to report" and still confirm.
        if (localDb) {
          pendingCount = await getPendingCount(localDb);
          // The honest signal for the boards sentence is whether a catalog is
          // actually on disk (what the wipe deletes), NOT the syncEnabledBoards
          // toggle list: a feature-flag rollback clears the list while the rows
          // remain, and those users lose the most. See hasDownloadedBoardData.
          hasDownloads = await hasDownloadedBoardData(localDb);
        }
      } catch {
        pendingCount = 0;
        hasDownloads = false;
      }

      const message = [
        hasDownloads ? t('mobile.signOut.messageOffline') : t('mobile.signOut.message'),
        ...(pendingCount > 0 ? [t('mobile.signOut.pending', { count: pendingCount })] : []),
      ].join('\n\n');

      const confirmed = await confirm({
        title: t('mobile.signOut.title'),
        message,
        confirmLabel: t('mobile.signOut.confirm'),
        cancelLabel: t('mobile.signOut.cancel'),
        destructive: true,
      });
      if (!confirmed) return;

      await signOut('manual');
    } catch (error) {
      reportError(error);
    } finally {
      inFlightRef.current = false;
    }
  }, [confirm, signOut, t]);
}
