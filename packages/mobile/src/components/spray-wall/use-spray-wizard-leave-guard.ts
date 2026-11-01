import { useEffect, useState } from 'react';
import { unstable_useIsNavigating as useIsNavigating, usePreventRemove } from 'expo-router';

/** Keep native and JS navigation together while the wizard decides how to leave. */
export function useSprayWizardLeaveGuard(confirmLeave: (onConfirm: () => void) => void, preventRemove = true): void {
  const [leaving, setLeaving] = useState(false);
  const isNavigating = useIsNavigating();
  useEffect(() => {
    // repeat() queues navigation and disables this hook. Another guard can keep
    // us mounted; commit false first, then rearm after that queue has settled.
    if (leaving && !isNavigating) setLeaving(false);
  }, [leaving, isNavigating]);
  // Dirtiness and hand-over are refs, so protection must not wait for a render.
  usePreventRemove(preventRemove && !leaving, ({ repeat }) => {
    confirmLeave(() => {
      setLeaving(true);
      repeat();
    });
  });
}
