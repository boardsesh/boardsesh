import { useCallback, useRef, useState } from 'react';

/** A late submit result belongs to the visible form that submitted it. A record
 * switch or close/reopen retires its error setter immediately, before effects. */
export function useScopedSheetError(scope: string, visible: boolean) {
  const identity = useRef({ scope, visible, generation: 0 });
  if (identity.current.scope !== scope || identity.current.visible !== visible) {
    identity.current = { scope, visible, generation: identity.current.generation + 1 };
  }
  const generation = identity.current.generation;
  const [error, setError] = useState<{ generation: number; message: string } | null>(null);
  const clearError = useCallback(() => setError(null), []);
  const setSubmitError = useCallback(
    (message: string | null) => {
      if (!identity.current.visible || identity.current.generation !== generation) return;
      setError(message ? { generation, message } : null);
    },
    [generation],
  );
  return {
    submitError: error?.generation === generation ? error.message : null,
    setSubmitError,
    clearError,
  };
}
