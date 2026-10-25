import { useState } from 'react';
import { usePreventRemove } from 'expo-router';

/** Keep native and JS navigation together while the wizard decides how to leave. */
export function useSprayWizardLeaveGuard(confirmLeave: (onConfirm: () => void) => void): void {
  const [leaving, setLeaving] = useState(false);
  // Dirtiness and hand-over are refs, so protection must not wait for a render.
  usePreventRemove(!leaving, ({ repeat }) => {
    confirmLeave(() => {
      setLeaving(true);
      repeat();
    });
  });
}
