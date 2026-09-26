import { isLinkableBoard } from '../integrations/board-link-eligibility';

export type ShouldOfferLinkInput = {
  enabled: boolean;
  boardType: string | undefined;
  isOffline: boolean;
  answered: boolean | undefined;
  hasLinkedAccount: boolean | undefined;
};

export type ShouldOfferLinkDecision = 'wait' | 'none' | 'show';

// Unknown storage or credentials never count as an unlinked account.
export function shouldOfferLink(input: ShouldOfferLinkInput): ShouldOfferLinkDecision {
  if (!input.enabled || !isLinkableBoard(input.boardType) || input.isOffline) return 'none';
  if (input.answered === undefined) return 'wait';
  if (input.answered) return 'none';
  if (input.hasLinkedAccount === undefined) return 'wait';
  if (input.hasLinkedAccount) return 'none';
  return 'show';
}
