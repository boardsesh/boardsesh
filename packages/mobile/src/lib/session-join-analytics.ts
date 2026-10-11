import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from './analytics';
import type { JoinSessionPreview } from './graphql/hooks/use-session-detail';

/**
 * An invite that did NOT end in a join (#6004). A join that worked is
 * `Session Joined`; before this event the four ways an invite could dead-end
 * left no trace, so "invites opened" could not be told from "invites joined".
 *
 * `host_away` is a good invite that cannot be joined yet: the session is
 * running, nobody is connected, and the wall is one the backend only names to
 * people already in the session.
 */
export type SessionJoinOutcome = 'not_found' | 'ended' | 'host_away' | 'sign_in_needed' | 'error';

/** Where it stopped: loading the invite, or the join itself after tapping Join. */
export type SessionJoinStage = 'preview' | 'join';

export function trackSessionJoinOutcome(sessionId: string, outcome: SessionJoinOutcome, stage: SessionJoinStage): void {
  track(SHARED_EVENTS.SessionJoinOutcome, { sessionId, outcome, stage });
}

/** What the join screen knows when it renders. */
export type JoinScreenState = {
  isAuthenticated: boolean;
  isLoading: boolean;
  isError: boolean;
  session: JoinSessionPreview | null | undefined;
};

/**
 * The dead end the join screen is showing, or null while it is loading or
 * showing a session that can be joined. Same order as the screen's own
 * branches, so the event names what the climber is looking at.
 */
export function joinScreenDeadEnd(state: JoinScreenState): SessionJoinOutcome | null {
  if (!state.isAuthenticated) return 'sign_in_needed';
  if (state.isLoading) return null;
  if (state.isError) return 'error';
  if (!state.session) return 'not_found';
  if (isSessionPreviewHostAway(state.session)) return 'host_away';
  if (isSessionPreviewEnded(state.session)) return 'ended';
  return null;
}

/** Running, with nobody connected and no board path to join on. */
export function isSessionPreviewHostAway(session: JoinSessionPreview): boolean {
  return session.invite?.state === 'host_away';
}

/** Ended by its own timestamp, or reported ended by the invite preview. */
export function isSessionPreviewEnded(session: JoinSessionPreview): boolean {
  return session.endedAt != null || session.invite?.state === 'ended';
}
