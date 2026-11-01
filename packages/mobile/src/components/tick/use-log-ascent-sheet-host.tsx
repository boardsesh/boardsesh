import { useCallback, useRef } from 'react';
import type { LogAscentInput } from '../../providers/drawer-host-provider';
import type { PresenterGroup } from '../../providers/sheet-presentation-provider';
import { usePrivacyScopedState } from '../../hooks/use-privacy-scoped-state';
import { LogAscentSheet } from '../LogAscentSheet';

type TickRequest = { id: number; input: LogAscentInput; visible: boolean };
type TickHostState = { current: TickRequest; pending: TickRequest | null };

/** Mount the returned sheet at the native presenter that owns its opener. */
export function useLogAscentSheetHost(presenterGroup?: PresenterGroup, parentSheetId?: string) {
  const nextRequestId = useRef(0);
  const [state, setState] = usePrivacyScopedState<TickHostState>(null);
  const openLogAscent = useCallback(
    (input: LogAscentInput) => {
      const request: TickRequest = { id: ++nextRequestId.current, input, visible: true };
      setState((previous) => {
        if (!previous) return { current: request, pending: null };
        // Ignore duplicate taps. A new open during dismissal waits for that
        // native host to settle instead of tearing it down mid-animation.
        if (previous.current.visible) return previous;
        return { ...previous, pending: request };
      });
    },
    [setState],
  );
  const reset = useCallback(() => setState(null), [setState]);
  const current = state?.current;
  const requestId = current?.id;
  const close = useCallback(() => {
    setState((previous) =>
      previous && previous.current.id === requestId
        ? { ...previous, current: { ...previous.current, visible: false } }
        : previous,
    );
  }, [requestId, setState]);
  const clear = useCallback(() => {
    setState((previous) => {
      if (!previous || previous.current.id !== requestId || previous.current.visible) return previous;
      return previous.pending ? { current: previous.pending, pending: null } : null;
    });
  }, [requestId, setState]);

  const sheet = current ? (
    <LogAscentSheet
      key={current.id}
      {...current.input}
      visible={current.visible}
      onClose={close}
      onFullyDismissed={clear}
      presenterGroup={presenterGroup}
      parentSheetId={parentSheetId}
      stacked={presenterGroup !== undefined}
    />
  ) : null;
  return { openLogAscent, reset, sheet, hasRequest: state !== null };
}
