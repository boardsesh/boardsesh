'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useShakeDetector } from '@/app/hooks/use-shake-detector';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { getShakeToReportDismissed, setShakeToReportDismissed } from '@/app/lib/user-preferences-db';
import { BugReportDialog } from './bug-report-dialog';

/**
 * Mounts an accelerometer listener at app root and opens the bug-report
 * dialog on a strong shake. Listener is paused while the dialog is open so
 * a continuous shake doesn't re-trigger.
 *
 * The dialog exposes a "Don't show this again" escape hatch — if the user
 * picks it we persist the choice to IndexedDB and detach the detector for
 * good. The manual drawer entry is unaffected.
 */
export const ShakeToReportProvider: React.FC = () => {
  const [open, setOpen] = useState(false);
  // null = hydration pending. We keep the detector detached until IndexedDB
  // resolves: defaulting to "not dismissed" would let a previously opted-out
  // user see the dialog fire if they happen to shake during the ~100-300ms
  // hydration window, silently overriding their explicit opt-out. First-time
  // users lose the same window of shake availability, which is an acceptable
  // trade — they're not likely to shake the phone in the first 300ms of load.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const { showMessage } = useSnackbar();

  useEffect(() => {
    let cancelled = false;
    getShakeToReportDismissed()
      .then((value) => {
        if (!cancelled) setDismissed(value);
      })
      .catch(() => {
        // IndexedDB can fail in private browsing or when the storage quota is
        // exhausted. Fall back to "not dismissed" so the feature is still
        // available — a broken opt-out is less bad than a silently dead
        // detector the user can never re-enable via the normal path.
        if (!cancelled) setDismissed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleShake = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  const handleDontShowAgain = useCallback(() => {
    setDismissed(true);
    setOpen(false);
    void setShakeToReportDismissed(true);
    showMessage('Shake to report off. Tap your avatar up top to send feedback.', 'info', undefined, 6000);
  }, [showMessage]);

  useShakeDetector(handleShake, { enabled: !open && dismissed === false });

  return (
    <BugReportDialog
      open={open}
      onClose={handleClose}
      source="shake_bug"
      secondaryAction={{ label: "Don't show this again", onClick: handleDontShowAgain }}
    />
  );
};
