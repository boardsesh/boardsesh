import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getPendingCount } from '@boardsesh/offline-sync';
import { useAuth } from '../providers/auth-provider';
import { useConfirm } from '../providers/dialog-provider';
import { getDatabaseHandle } from '../db';
import { hasDownloadedBoardData } from '../db/queries/board-download-status';
import { reportError } from '../lib/error-reporting';
import { showSignOutFailure } from '../lib/sign-out-failure-alert';

/**
 * The manual sign-out flow: say what leaving costs, then run it.
 *
 * Sign-out is destructive in two ways nobody can see from the button —
 * `purgeLocalDataForSignOut` deletes the downloaded board catalogs and the offline
 * logbook, and any writes still queued go with them (issue #3621). Both entry points
 * (the More tab and the user drawer) go through here so the warning cannot drift
 * apart from one of them again; the drawer used to sign out on the first tap with no
 * confirmation at all.
 *
 * It ALWAYS confirms, and composes the message from what is actually true for this
 * device: the downloaded-boards sentence only when a catalog is really on disk, the
 * unsynced-writes sentence only when the queue isn't empty, and otherwise the plain
 * "you'll need to sign in again".
 *
 * No drain here. `signOut` already runs one bounded best-effort drain of its own
 * (3s), so draining before the dialog would mean two drains and a user who meant to
 * cancel staring at a spinner first. The consequence is that the count shown is
 * pre-drain and can overstate the loss, which is why the copy promises an attempt to
 * sync rather than a guaranteed discard. The exact post-drain number goes to
 * analytics from inside the wipe's own transaction.
 *
 * The confirm lives in this hook rather than in AuthProvider's `signOut` on purpose.
 * The forced paths — the interceptor's failed-refresh 401 and checkAuth's proactive
 * expiry — reach the cleanup directly and have no meaningful moment to ask (the token
 * is already dead), so putting the dialog in the provider would mean an opt-out flag
 * on every one of them.
 */
export function useConfirmSignOut(): () => Promise<void> {
  const confirm = useConfirm();
  const { signOut } = useAuth();
  const { t } = useTranslation('common');
  // A double-tap must not stack two dialogs or two sign-outs. Held only for the
  // duration of one flow (see the finally) so a cancel — or a sign-out that resolves
  // without navigating away — leaves the button usable for a retry.
  const inFlightRef = useRef(false);

  return useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const localDb = getDatabaseHandle();
      let pendingCount = 0;
      let hasDownloads = false;
      try {
        // No handle means offline storage never initialised this session, so there is
        // nothing local to lose. A read failure is not a reason to skip the warning —
        // fall back to "nothing to report" and still confirm.
        if (localDb) {
          pendingCount = await getPendingCount(localDb);
          // The honest signal for the boards sentence is whether a catalog is on disk
          // (what the wipe deletes), NOT the syncEnabledBoards toggle list: a
          // feature-flag rollback clears the list while the rows remain, and those
          // users lose the most. See hasDownloadedBoardData.
          hasDownloads = await hasDownloadedBoardData(localDb);
        }
      } catch {
        pendingCount = 0;
        hasDownloads = false;
      }

      const message = [
        hasDownloads ? t('mobile.more.signOut.messageOffline') : t('mobile.more.signOut.message'),
        ...(pendingCount > 0 ? [t('mobile.more.signOut.pendingMessage', { count: pendingCount })] : []),
      ].join('\n\n');

      const confirmed = await confirm({
        title: t('mobile.more.signOut.title'),
        message,
        confirmLabel: t('mobile.more.signOut.confirm'),
        cancelLabel: t('mobile.more.signOut.cancel'),
        destructive: true,
      });
      if (!confirmed) return;

      await signOut('manual');
    } catch (error) {
      reportError(error);
      showSignOutFailure(t('mobile.more.signOut.failureTitle'), t('mobile.more.signOut.failure'));
    } finally {
      inFlightRef.current = false;
    }
  }, [confirm, signOut, t]);
}
