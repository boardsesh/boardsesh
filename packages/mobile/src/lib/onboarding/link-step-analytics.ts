// Prompt outcomes are separate from the source-tagged credential attempt events.
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { track } from '../analytics';

export type LinkPromptOutcome = 'linked' | 'declined' | 'abandoned';

export function trackLinkPromptShown(boardType: AuroraBoardName): void {
  track(SHARED_EVENTS.OnboardingLinkPromptShown, { boardType });
}

export function trackLinkPromptResolved(boardType: AuroraBoardName, outcome: LinkPromptOutcome): void {
  track(SHARED_EVENTS.OnboardingLinkPromptResolved, { boardType, outcome });
}
