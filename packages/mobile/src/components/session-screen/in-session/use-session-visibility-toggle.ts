import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useUpdateSession } from '../../../lib/graphql/hooks';
import type { SessionPreview } from '../../../lib/graphql/operations';
import { track } from '../../../lib/analytics';
import { getStoredSessionVisibility, setStoredSessionVisibility } from '../../../lib/session-store';
import { useToast } from '../../../providers/toast-provider';

type SessionVisibilityToggle = {
  /**
   * What the switch shows: the value being saved, else the known value. Null
   * while nothing is known, and then the switch must not render: guessing "on"
   * would tell the creator of a private session that it is live.
   */
  isPublic: boolean | null;
  setIsPublic: (next: boolean) => void;
};

type UseSessionVisibilityToggleParams = {
  sessionId: string | null;
  /** `isPublic` from the `session` query. Undefined while that query returns null (empty live roster). */
  serverIsPublic: boolean | undefined;
  /** True once the live roster names us, which means the socket join has landed. */
  rosterResolved: boolean;
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
 * The in-session "Show this session live" switch.
 *
 * Known value, in order: what this device last saved or started with for this
 * session (session-store), then the server's `isPublic`. The server can't
 * always answer: the `session` query is null while the live roster is empty.
 *
 * Saves run one at a time. A flip while a save is out only records the value
 * the creator wants; when the save settles, one more goes out if the server's
 * echo still differs. Firing a save per flip let two in-flight requests land
 * out of order and leave the server on the value the creator flipped away from.
 */
export function useSessionVisibilityToggle({
  sessionId,
  serverIsPublic,
  rosterResolved,
}: UseSessionVisibilityToggleParams): SessionVisibilityToggle {
  const { t } = useTranslation('session');
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { mutateAsync } = useUpdateSession();

  // `undefined` = the stored value hasn't been read yet for this session.
  const [storedIsPublic, setStoredIsPublic] = useState<boolean | null | undefined>(undefined);
  // The value the creator last asked for while a save is out (or queued).
  const [pendingIsPublic, setPendingIsPublic] = useState<boolean | null>(null);
  const desiredRef = useRef<boolean | null>(null);
  const inFlightRef = useRef(false);
  // Bumped per session so a save settling for the previous session is ignored.
  const sessionEpochRef = useRef(0);

  useEffect(() => {
    sessionEpochRef.current += 1;
    desiredRef.current = null;
    inFlightRef.current = false;
    setPendingIsPublic(null);
    setStoredIsPublic(undefined);
    if (!sessionId) return undefined;
    let cancelled = false;
    void getStoredSessionVisibility(sessionId).then((stored) => {
      if (!cancelled) setStoredIsPublic(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // A second-phone creator has nothing stored, and a preview fetched before the
  // socket join landed is null. Refetch once the roster names us.
  const serverKnown = serverIsPublic !== undefined;
  useEffect(() => {
    if (!sessionId || !rosterResolved || serverKnown) return;
    void queryClient.invalidateQueries({ queryKey: ['sessionPreview', sessionId] });
  }, [sessionId, rosterResolved, serverKnown, queryClient]);

  const knownIsPublic = storedIsPublic === undefined ? null : (storedIsPublic ?? serverIsPublic ?? null);

  const save = useCallback(
    (targetSessionId: string, firstValue: boolean, firstPreviousKnown: boolean | null) => {
      const epoch = sessionEpochRef.current;
      inFlightRef.current = true;

      const send = (value: boolean, previousKnown: boolean | null): void => {
        mutateAsync({ input: { sessionId: targetSessionId, isPublic: value } }).then(
          (updated) => {
            if (epoch !== sessionEpochRef.current) return;
            const confirmed = updated.isPublic;
            queryClient.setQueryData<SessionPreview | null>(['sessionPreview', targetSessionId], (previous) =>
              previous ? { ...previous, isPublic: confirmed } : previous,
            );
            setStoredIsPublic(confirmed);
            void setStoredSessionVisibility(targetSessionId, confirmed).catch(() => {});
            if (confirmed !== previousKnown) {
              track(SHARED_EVENTS.SessionVisibilityChanged, { isPublic: confirmed, phase: 'in_session' });
            }
            const desired = desiredRef.current;
            if (desired !== null && desired !== confirmed) {
              send(desired, confirmed);
              return;
            }
            inFlightRef.current = false;
            desiredRef.current = null;
            setPendingIsPublic(null);
          },
          () => {
            if (epoch !== sessionEpochRef.current) return;
            // The MutationCache's onError already reports the failure. Here the
            // switch only snaps back to the last known value and says so.
            inFlightRef.current = false;
            desiredRef.current = null;
            setPendingIsPublic(null);
            void queryClient.invalidateQueries({ queryKey: ['sessionPreview', targetSessionId] });
            showToast(t('mobile.sessionVisibility.updateError'), 'error');
          },
        );
      };

      send(firstValue, firstPreviousKnown);
    },
    [mutateAsync, queryClient, showToast, t],
  );

  const setIsPublic = useCallback(
    (next: boolean) => {
      if (!sessionId) return;
      desiredRef.current = next;
      setPendingIsPublic(next);
      if (inFlightRef.current) return;
      if (next === knownIsPublic) {
        desiredRef.current = null;
        setPendingIsPublic(null);
        return;
      }
      save(sessionId, next, knownIsPublic);
    },
    [sessionId, knownIsPublic, save],
  );

  return { isPublic: pendingIsPublic ?? knownIsPublic, setIsPublic };
}
