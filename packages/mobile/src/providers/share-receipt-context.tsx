import { createContext, useContext } from 'react';
import type { SharedBugDraft, SharedBugDraftUpdates, ShareReceiptNotice } from '../lib/feedback/shared-bug-draft.types';

export type ShareReceiptState = {
  draft: SharedBugDraft | null;
  pendingLink: string | null;
  notice: ShareReceiptNotice | null;
  revision: number;
  destination: 'bug' | 'beta' | null;
};
export type ShareReceiptActions = {
  updateDraft: (draftId: string, updates: SharedBugDraftUpdates) => Promise<void>;
  clearDraft: (draftId: string) => Promise<void>;
  finishDraftSubmission: (draftId: string, submittedAttachmentIds: readonly string[]) => Promise<boolean>;
  consumeLink: (link: string) => Promise<void>;
  clearNotice: () => void;
  consumeBugNavigation: () => void;
};

export const ShareReceiptStateContext = createContext<ShareReceiptState | null>(null);
export const ShareReceiptActionsContext = createContext<ShareReceiptActions | null>(null);

export function useShareReceipt() {
  const state = useContext(ShareReceiptStateContext);
  const actions = useContext(ShareReceiptActionsContext);
  if (!state || !actions) throw new Error('ShareReceiptProvider is missing');
  return { ...state, ...actions };
}

export function useSharedBugDraft() {
  const { draft, updateDraft, clearDraft, finishDraftSubmission } = useShareReceipt();
  return { draft, updateDraft, clearDraft, finishDraftSubmission };
}
