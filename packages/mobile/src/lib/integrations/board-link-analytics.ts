import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { track } from '../analytics';
import type { BoardAccountErrorCode } from '../aurora-credentials';

export type BoardLinkSource = 'integrations' | 'onboarding' | 'progress_empty' | 'logbook_empty';

export type BoardLinkFailureReason = BoardAccountErrorCode;

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
