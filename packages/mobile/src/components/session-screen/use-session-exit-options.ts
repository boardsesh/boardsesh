import { useEffect, useMemo, useState } from 'react';
import { useQueueSessionControls, useQueueLiveStats } from '../../providers/queue-provider';
import { useSessionOwnerUserId } from '../../lib/graphql/hooks';
import { getStoredCreatedSessionId } from '../../lib/session-store';

export type SessionExitMode = 'end' | 'leave';

export type SessionExitOptions = {
  /**
   * Whether to offer the destructive "end for everyone" action at all.
   *
   * PERMISSIVE ON UNKNOWN, and that is deliberate — do not "harden" this to
   * fail closed. We hide End only when we POSITIVELY know we are not the
   * creator. Ownership is unknown for the first render of every session (the
   * owner query is in flight), for anonymous sessions, and whenever a bundle
   * is newer than the backend — failing closed in those windows would strand a
   * creator with no way to end their own session and no explanation. Being
   * wrong the other way is cheap: the server re-checks creator/leader and
   * refuses, and since #3502 that refusal leaves cleanly with an honest
   * message instead of a generic failure. Same reasoning as `canEditTitle` in
   * InSessionView.
   */
  canEnd: boolean;
  /**
   * Whether THIS DEVICE started the session (as opposed to joining it). Drives
   * emphasis only — which action the confirmation sheet leads with — never
   * whether an action exists. See session-store.ts for why device provenance,
   * and not the roster, is the signal: one signed-in climber on two phones is
   * a single participant server-side, so no roster-derived value can tell the
   * two devices apart.
   */
  startedOnThisDevice: boolean;
  /** The action the exit sheet opens on. The other one stays one tap away. */
  defaultMode: SessionExitMode;
};

/**
 * Resolves what "get me out of here" should mean for this device in this
 * session: end it for everyone, or just drop out.
 *
 * Subscribes to contexts the session surfaces already consume
 * (`useQueueSessionControls` / `useQueueLiveStats`), so it adds no new
 * re-render sources.
 */
export function useSessionExitOptions(): SessionExitOptions {
  const { sessionId, participantId } = useQueueSessionControls();
  const { sessionUsers } = useQueueLiveStats();
  const { data: ownerUserId } = useSessionOwnerUserId(sessionId ?? undefined);

  // `undefined` = the SecureStore read hasn't landed yet, which is distinct from
  // `null` = read, and this device didn't start anything. The difference decides
  // the first frame's emphasis (see the fallback in the memo below).
  const [createdSessionId, setCreatedSessionId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setCreatedSessionId(undefined);
    void getStoredCreatedSessionId().then((stored) => {
      if (!cancelled) setCreatedSessionId(stored);
    });
    return () => {
      cancelled = true;
    };
    // Re-read per session so a start → end → join sequence can't carry stale
    // provenance into the next session.
  }, [sessionId]);

  // Our own database user id. Matched on `participantId`, NOT `clientId`:
  // roster entries are keyed by participant id, which equals the connection id
  // only for anonymous users (backend: `client.userId || connectionId`).
  const selfUserId = useMemo(
    () => sessionUsers.find((user) => user.id === participantId)?.userId ?? null,
    [sessionUsers, participantId],
  );

  return useMemo(() => {
    const isKnownForeign = ownerUserId != null && selfUserId != null && ownerUserId !== selfUserId;
    const canEnd = !isKnownForeign;
    // Honest — stays false until the read lands, so the analytics split doesn't
    // count an unresolved device as the one that started the session.
    const startedOnThisDevice = createdSessionId != null && createdSessionId === sessionId;
    // Emphasis while the read is still in flight. Falling back to `end` keeps
    // the first frame byte-identical to the pre-#3502 chrome, so a creator (the
    // common case) never sees the control change identity under their thumb.
    // The joiner's brief red Stop is safe: `canEnd` is computed independently of
    // provenance, so a known-foreign participant is still refused the End mode
    // by the sheet even if they tap during that window.
    const provenanceResolved = createdSessionId !== undefined;
    const leadWithEnd = provenanceResolved ? startedOnThisDevice : true;
    return {
      canEnd,
      startedOnThisDevice,
      // Lead with End only on the phone that started the party AND is still
      // allowed to end it. Everything else — the same climber's second phone,
      // a friend's party — leads with the non-destructive exit.
      defaultMode: leadWithEnd && canEnd ? 'end' : 'leave',
    };
  }, [ownerUserId, selfUserId, createdSessionId, sessionId]);
}
