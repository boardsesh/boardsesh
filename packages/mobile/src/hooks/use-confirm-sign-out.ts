import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getPendingCount } from '@boardsesh/offline-sync';
import { useAuth } from '../providers/auth-provider';
import { useConfirm } from '../providers/dialog-provider';
import { getDatabaseHandle } from '../db';
import { getSetting } from '../settings/hooks';
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
  // dialogs; this is the guard that keeps it to one. Never reset — a confirmed
  // sign-out unmounts this tree, and a cancel resets it explicitly below.
  const inFlightRef = useRef(false);

  return useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const localDb = getDatabaseHandle();
      let pendingCount = 0;
      try {
        // No handle means offline storage failed to initialise this session, so
        // there is no queue to lose. A read failure is not a reason to skip the
        // warning — fall back to "nothing pending" and still confirm.
        pendingCount = localDb ? await getPendingCount(localDb) : 0;
      } catch {
        pendingCount = 0;
      }

      // The enabled list is the ground truth for "this user set up downloads", and
      // the wipe is deliberately not flag-gated, so this isn't gated on
      // useOfflineDownloadsEnabled either: a user whose flag was rolled back can
      // still be holding downloaded boards, and they lose them just the same. An
      // empty list means there's nothing to warn about, so the sentence stays off
      // and no flag-off user is told about a feature they don't have.
      const hasDownloads = getSetting('syncEnabledBoards').length > 0;

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
      if (!confirmed) {
        inFlightRef.current = false;
        return;
      }

      await signOut('manual');
    } catch (error) {
      inFlightRef.current = false;
      reportError(error);
    }
  }, [confirm, signOut, t]);
}
