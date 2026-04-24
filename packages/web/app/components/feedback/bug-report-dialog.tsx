'use client';

import React from 'react';
import type { AppFeedbackSource } from '@boardsesh/shared-schema';
import { FeedbackDialog, type FeedbackDialogSecondaryAction } from './feedback-dialog';

type BugReportDialogProps = {
  open: boolean;
  onClose: () => void;
  /** 'shake_bug' for the motion trigger, 'drawer_bug' for the drawer button. */
  source: Extract<AppFeedbackSource, 'shake_bug' | 'drawer_bug'>;
  /** Muted action shown below the form — shake variant uses this for "Don't show this again". */
  secondaryAction?: FeedbackDialogSecondaryAction;
};

export const BugReportDialog: React.FC<BugReportDialogProps> = ({ open, onClose, source, secondaryAction }) => {
  return <FeedbackDialog open={open} onClose={onClose} source={source} mode="bug" secondaryAction={secondaryAction} />;
};
