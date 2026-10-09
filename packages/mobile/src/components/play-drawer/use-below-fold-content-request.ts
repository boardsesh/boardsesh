import { useCallback, useRef, useState } from 'react';

/**
 * Opens the play drawer's deferred-content gate once per mount. Native touch
 * scrolling requests it after a deliberate drag; browser wheel, trackpad,
 * scrollbar and keyboard scrolling request it from the first positive offset.
 */
export function useBelowFoldContentRequest(): {
  requested: boolean;
  request: () => void;
  requestFromScrollOffset: (offsetY: number) => void;
} {
  const [requested, setRequested] = useState(false);
  const requestedRef = useRef(false);

  const request = useCallback(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    setRequested(true);
  }, []);

  const requestFromScrollOffset = useCallback(
    (offsetY: number) => {
      if (offsetY > 0) request();
    },
    [request],
  );

  return { requested, request, requestFromScrollOffset };
}
