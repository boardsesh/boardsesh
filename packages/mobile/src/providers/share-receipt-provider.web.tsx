import { useMemo, type ReactNode } from 'react';
import { ShareReceiptStateContext, ShareReceiptActionsContext } from './share-receipt-context';
export { useSharedBugDraft, useShareReceipt } from './share-receipt-context';

const state = { draft: null, pendingLink: null, notice: null, revision: 0, destination: null };
const noOperation = async () => {};
export function ShareReceiptProvider({ children }: { children: ReactNode }) {
  const actions = useMemo(
    () => ({
      updateDraft: noOperation,
      clearDraft: noOperation,
      finishDraftSubmission: async () => true,
      consumeLink: noOperation,
      clearNotice: () => {},
      consumeBugNavigation: () => {},
    }),
    [],
  );
  return (
    <ShareReceiptActionsContext.Provider value={actions}>
      <ShareReceiptStateContext.Provider value={state}>{children}</ShareReceiptStateContext.Provider>
    </ShareReceiptActionsContext.Provider>
  );
}
