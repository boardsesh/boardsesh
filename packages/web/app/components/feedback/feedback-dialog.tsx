'use client';

import React from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { FeedbackForm } from './feedback-form';
import { useSubmitAppFeedback } from '@/app/hooks/use-submit-app-feedback';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { setFeedbackStatus } from '@/app/lib/feedback-prompt-db';
import type { AppFeedbackSource } from '@boardsesh/shared-schema';
import styles from './feedback-dialog.module.css';

export type FeedbackDialogMode = 'rating' | 'bug';

export interface FeedbackSubmission {
  rating: number | null;
  comment: string | null;
}

interface FeedbackDialogProps {
  open: boolean;
  onClose: () => void;
  source: AppFeedbackSource;
  title?: string;
  mode?: FeedbackDialogMode;
  /**
   * Fires after the user's submission is accepted by the form and the mutation
   * has been kicked off (fire-and-forget). Used by callers that want to chain
   * a follow-up step — e.g. the drawer asking about an App Store review after
   * a rating submission. Not invoked when the form is cancelled/closed.
   */
  onSubmitted?: (submission: FeedbackSubmission) => void;
}

const FeedbackDialogBody: React.FC<Omit<FeedbackDialogProps, 'open'>> = ({
  onClose,
  source,
  title,
  mode = 'rating',
  onSubmitted,
}) => {
  const { mutateAsync } = useSubmitAppFeedback();
  const { showMessage } = useSnackbar();
  const isBug = mode === 'bug';
  const resolvedTitle = title ?? (isBug ? 'Report a bug' : 'Rate Boardsesh');

  const handleSubmit = (values: FeedbackSubmission) => {
    if (isBug) {
      // Bug-mode form guarantees comment length via canSubmit.
      if (!values.comment) {
        onClose();
        return;
      }
    } else {
      // Rating-mode form disables Send until a rating is picked.
      if (values.rating === null) {
        onClose();
        return;
      }
      // Suppress the automatic banner for users who manually engaged.
      void setFeedbackStatus('submitted');
    }

    // Use mutateAsync + promise chain, not mutate() with per-call callbacks.
    // The dialog body unmounts synchronously when we call onClose() below,
    // which tears down React Query's MutationObserver and cancels any
    // callbacks attached via mutate()'s options — so `onSubmitted` never
    // fires and the chained StoreReviewPromptDialog never opens. The
    // mutation promise itself survives the unmount (the mutation isn't
    // cancelled, only the observer is removed), so a raw .then/.catch
    // chain still runs the post-submit hooks reliably.
    mutateAsync({
      rating: isBug ? null : values.rating,
      comment: values.comment,
      source,
    })
      .then(() => {
        showMessage(isBug ? 'Bug logged — thanks.' : 'Thanks — logged.', 'success');
        // Fire chained follow-ups (e.g. "also leave a store review?") only
        // on successful submission. Otherwise we'd be prompting the user to
        // publicly review the app right after telling them their feedback
        // didn't save.
        onSubmitted?.(values);
      })
      .catch(() => {
        showMessage("Couldn't send — we'll keep your feedback.", 'warning');
      });
    onClose();
  };

  return (
    <div className={styles.dialogBody}>
      <IconButton aria-label="Close" onClick={onClose} className={styles.closeButton} size="small">
        <CloseOutlined fontSize="small" />
      </IconButton>
      <DialogContent>
        <FeedbackForm
          mode={isBug ? 'bug' : 'drawer-feedback'}
          title={resolvedTitle}
          submitLabel={isBug ? 'Send bug report' : 'Send'}
          onSubmit={handleSubmit}
          onCancel={onClose}
        />
      </DialogContent>
    </div>
  );
};

export const FeedbackDialog: React.FC<FeedbackDialogProps> = ({ open, onClose, source, title, mode, onSubmitted }) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      {open && (
        <FeedbackDialogBody onClose={onClose} source={source} title={title} mode={mode} onSubmitted={onSubmitted} />
      )}
    </Dialog>
  );
};
