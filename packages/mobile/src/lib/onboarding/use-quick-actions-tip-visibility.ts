import { useSyncExternalStore } from 'react';
import { getQuickActionsUsedSnapshot, subscribeToQuickActionsUsed } from './quick-actions-tip';

/** Menu use retires a visible tip or one waiting behind a higher-priority onboarding card. */
export function useQuickActionsTipVisibility(armed: boolean, higherPriorityTipVisible: boolean): boolean {
  const hasOpenedActions = useSyncExternalStore(
    subscribeToQuickActionsUsed,
    getQuickActionsUsedSnapshot,
    getQuickActionsUsedSnapshot,
  );
  return armed && !higherPriorityTipVisible && !hasOpenedActions;
}
