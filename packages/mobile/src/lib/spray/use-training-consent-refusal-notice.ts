import { useCallback } from 'react';
import { Alert } from 'react-native';

/**
 * How a refused "Help train hold finding" flip reaches an owner who is no longer
 * looking at the switch (SW-20, #5471).
 *
 * A native alert, which sits above every modal. Not a toast: Edit board is
 * pushed inside the boards modal, so the owner is still inside a modal after
 * leaving it, and the toast overlay draws behind one (`toast-provider.tsx`).
 *
 * The browser app has its own fork (`.web.ts`): `Alert.alert` does nothing on
 * react-native-web, and nothing there is native enough to cover the toast.
 */
export function useTrainingConsentRefusalNotice(): (message: string) => void {
  return useCallback((message: string) => Alert.alert(message), []);
}
