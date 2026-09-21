import { useSyncExternalStore } from 'react';
import { getQuickActionsUsedSnapshot, subscribeToQuickActionsUsed } from './quick-actions-tip';

/** Menu use retires a visible tip or one still waiting behind the reveal banner. */
export function useQuickActionsTipVisibility(armed: boolean, revealVisible: boolean): boolean {
  const hasOpenedActions = useSyncExternalStore(
    subscribeToQuickActionsUsed,
    getQuickActionsUsedSnapshot,
    getQuickActionsUsedSnapshot,
  );
  return armed && !revealVisible && !hasOpenedActions;
}
