import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../providers/dialog-provider';

/** Native sheets cannot veto a gesture after dismissal starts. Lock dismissal
 * while edits exist; Cancel remains available and confirms before discarding. */
export function useUnsavedSheetGuard({
  visible,
  dirty,
  busy = false,
  onClose,
  onDiscard,
  scope,
}: {
  visible: boolean;
  dirty: boolean;
  busy?: boolean;
  onClose: () => void;
  onDiscard?: () => void;
  scope?: string;
}) {
  const confirm = useConfirm();
  const { t } = useTranslation('common');
  const latest = useRef({ visible, dirty, busy, onClose, onDiscard });
  latest.current = { visible, dirty, busy, onClose, onDiscard };
  const generation = useRef(0);
  const prompting = useRef(false);
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [visible, scope]);

  const requestClose = useCallback(async () => {
    const current = latest.current;
    if (!current.visible || current.busy || prompting.current) return;
    if (!current.dirty) {
      current.onClose();
      return;
    }
    prompting.current = true;
    const requestedGeneration = generation.current;
    try {
      const discard = await confirm({
        title: t('unsavedChanges.title'),
        message: t('unsavedChanges.message'),
        confirmLabel: t('unsavedChanges.discard'),
        cancelLabel: t('unsavedChanges.keepEditing'),
        destructive: true,
      });
      // A delayed answer must not close a newly opened form or an in-flight save.
      if (discard && requestedGeneration === generation.current && latest.current.visible && !latest.current.busy) {
        latest.current.onDiscard?.();
        latest.current.onClose();
      }
    } finally {
      prompting.current = false;
    }
  }, [confirm, t]);

  return { requestClose, enablePanDownToClose: !dirty && !busy };
}
