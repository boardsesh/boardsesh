import { memo } from 'react';
import { useSessionOwnerUserId, useSessionPreview } from '../../../lib/graphql/hooks';
import { SessionVisibilityRow } from '../SessionVisibilityRow';
import { isKnownSessionCreator, useSessionVisibilityToggle } from './use-session-visibility-toggle';

type SessionVisibilityControlProps = {
  sessionId: string | null;
  /** Our own database user id, resolved from the live roster (null until it lands). */
  selfUserId: string | null;
  /** This phone started the session (device provenance, see session-store). */
  startedOnThisDevice: boolean;
};

/**
 * The in-session "Show this session live" switch, for the creator only. The
 * server refuses `updateSession` from anyone else, so the switch stays hidden
 * until we know the viewer started the session. It also stays hidden while the
 * session's visibility is unknown, rather than guessing.
 *
 * Both queries are already warm: InSessionView reads the preview for the title
 * and useSessionExitOptions reads the owner.
 */
export const SessionVisibilityControl = memo(function SessionVisibilityControl({
  sessionId,
  selfUserId,
  startedOnThisDevice,
}: SessionVisibilityControlProps) {
  const { data: ownerUserId } = useSessionOwnerUserId(sessionId ?? undefined);
  const { data: sessionPreview } = useSessionPreview(sessionId ?? undefined);
  const { isPublic, setIsPublic } = useSessionVisibilityToggle({
    sessionId,
    serverIsPublic: sessionPreview?.isPublic,
    rosterResolved: selfUserId != null,
  });

  if (!sessionId || isPublic === null) return null;
  if (!isKnownSessionCreator({ startedOnThisDevice, ownerUserId, selfUserId })) return null;

  return <SessionVisibilityRow isPublic={isPublic} onChange={setIsPublic} />;
});
