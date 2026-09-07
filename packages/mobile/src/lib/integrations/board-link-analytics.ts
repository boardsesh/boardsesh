// Thin wrappers around the board-account linking events, so the surfaces that
// offer linking stay free of property-key bookkeeping. Mirrors the shape of
// `src/lib/onboarding/onboarding-analytics.ts`.
//
// The funnel this feeds did not exist before: nothing anywhere emitted an event,
// a person property or even a log line when a climber linked a board account, so
// "how many people link, and how many try and fail?" was unanswerable. Every
// surface that can start a link reports through here with its own `source`, which
// is what makes the surfaces comparable.
//
// The invariant, mirrored from the event catalogue: **every Started resolves to
// exactly one Linked or Failed.** Nothing here enforces that — callers must fire a
// terminal event on every path, including the ones that abandon. The onboarding
// tour learned this the hard way (see the `trackTourDismissed` note): ~a third of
// its Starts used to resolve to nothing at all, which quietly deflated Completed.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { track } from '../analytics';
import type { BoardAccountErrorCode } from '../aurora-credentials';

/**
 * Which surface offered the link. Not cosmetic: the whole point of the funnel is
 * to compare Settings (where a climber has already gone looking) against the
 * places we interrupt them, so pooling these would answer nothing.
 */
export type BoardLinkSource = 'integrations' | 'onboarding' | 'progress_empty' | 'logbook_empty';

/**
 * A dismissed browser sheet is a decision, not a fault, so it is kept out of the
 * error codes rather than collapsed into `request_failed`.
 */
export type BoardLinkFailureReason = BoardAccountErrorCode | 'cancelled';

type LinkContext = { boardType: AuroraBoardName; source: BoardLinkSource };

export function trackLinkStarted({ boardType, source }: LinkContext): void {
  track(SHARED_EVENTS.BoardAccountLinkStarted, { boardType, source });
}

export function trackLinkSucceeded({ boardType, source }: LinkContext): void {
  track(SHARED_EVENTS.BoardAccountLinked, { boardType, source });
}

export function trackLinkFailed({ boardType, source }: LinkContext, reason: BoardLinkFailureReason): void {
  track(SHARED_EVENTS.BoardAccountLinkFailed, { boardType, source, reason });
}
