import { useCallback } from 'react';
import { useToast } from '../../providers/toast-provider';

/**
 * The browser app's notice for a refused "Help train hold finding" flip whose
 * owner is no longer looking at the switch (SW-20, #5471).
 *
 * A toast. The native file raises an alert, but `Alert.alert` does nothing on
 * react-native-web, so the refusal would be silent here. The toast overlay is
 * only covered by a native surface, and the browser has none.
 */
export function useTrainingConsentRefusalNotice(): (message: string) => void {
  const { showToast } = useToast();
  return useCallback((message: string) => showToast(message, 'error'), [showToast]);
}
