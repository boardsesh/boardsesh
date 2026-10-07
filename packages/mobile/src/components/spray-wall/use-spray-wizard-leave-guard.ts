import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';

/** Keep native and JS navigation together while the wizard decides how to leave. */
export function useSprayWizardLeaveGuard(confirmLeave: (onConfirm: () => void) => void): void {
  const navigation = useNavigation();
  // Dirtiness and hand-over are refs, so protection must not wait for a render.
  usePreventRemove(true, ({ data: { action } }) => {
    confirmLeave(() => navigation.dispatch(action));
  });
}
