import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useUpdateSession } from '../../../lib/graphql/hooks';
import type { SessionPreview } from '../../../lib/graphql/operations';
import { track } from '../../../lib/analytics';
import { reportHandledError } from '../../../lib/error-reporting';
import { useToast } from '../../../providers/toast-provider';

type SessionVisibilityToggle = {
  /** What the switch shows: the optimistic value while a save is out, else the server's. */
  isPublic: boolean;
  setIsPublic: (next: boolean) => void;
};

/**
 * Whether the viewer POSITIVELY started this session. Unlike `canEnd` and
 * `canEditTitle`, which stay permissive while ownership is unknown, a switch
 * that a joiner could flip and then watch bounce back is worse than one that
 * shows up a moment late, so unknown means no.
 *
 * `startedOnThisDevice` covers the first seconds of a fresh session, before the
 * roster names us. The owner match covers the same climber's second phone.
 */
export function isKnownSessionCreator({
  startedOnThisDevice,
  ownerUserId,
  selfUserId,
}: {
  startedOnThisDevice: boolean;
  ownerUserId: string | null | undefined;
  selfUserId: string | null;
}): boolean {
  if (startedOnThisDevice) return true;
  return ownerUserId != null && selfUserId != null && ownerUserId === selfUserId;
}

/**
 * The in-session "Show this session live" switch: flips at once, saves through
 * `updateSession`, and snaps back with a toast when the save fails.
 *
 * Only the latest flip settles the switch. A slow earlier save that lands after
 * a newer flip is ignored, so a quick on-off-on never shows a stale value.
 */
export function useSessionVisibilityToggle(
  sessionId: string | null,
  serverIsPublic: boolean | undefined,
): SessionVisibilityToggle {
  const { t } = useTranslation('session');
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { mutateAsync } = useUpdateSession();

  const [optimisticIsPublic, setOptimisticIsPublic] = useState<boolean | null>(null);
  const latestRequestRef = useRef(0);

  // A new session starts from its own server value, and a save still out for
  // the previous one must not settle this one's switch.
  useEffect(() => {
    latestRequestRef.current += 1;
    setOptimisticIsPublic(null);
  }, [sessionId]);

  // Hand the switch back to the server value once it agrees, so a later change
  // from the creator's other phone still shows up here.
  useEffect(() => {
    if (optimisticIsPublic !== null && serverIsPublic === optimisticIsPublic) {
      setOptimisticIsPublic(null);
    }
  }, [optimisticIsPublic, serverIsPublic]);

  const setIsPublic = useCallback(
    (next: boolean) => {
      if (!sessionId) return;
      latestRequestRef.current += 1;
      const requestId = latestRequestRef.current;
      setOptimisticIsPublic(next);

      mutateAsync({ input: { sessionId, isPublic: next } }).then(
        () => {
          if (requestId !== latestRequestRef.current) return;
          queryClient.setQueryData<SessionPreview | null>(['sessionPreview', sessionId], (previous) =>
            previous ? { ...previous, isPublic: next } : previous,
          );
          track(SHARED_EVENTS.SessionVisibilityChanged, { isPublic: next, phase: 'in_session' });
        },
        (error: unknown) => {
          if (requestId !== latestRequestRef.current) return;
          setOptimisticIsPublic(null);
          // An earlier flip may have landed, so the cached value can be stale.
          void queryClient.invalidateQueries({ queryKey: ['sessionPreview', sessionId] });
          reportHandledError(error, { tags: { source: 'sessionVisibility' } });
          showToast(t('mobile.sessionVisibility.updateError'), 'error');
        },
      );
    },
    [sessionId, mutateAsync, queryClient, showToast, t],
  );

  return { isPublic: optimisticIsPublic ?? serverIsPublic ?? true, setIsPublic };
}
