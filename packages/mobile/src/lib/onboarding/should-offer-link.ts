import { isLinkableBoard } from '../integrations/board-link-eligibility';

/**
 * Whether first-run should offer to link a board account, as one pure function so
 * every branch is unit-testable without a renderer. Same shape as
 * `decideBoardLookStep`.
 *
 * This step is the one skippable screen in an otherwise mandatory flow, and that
 * is deliberate. Issue #4961 stripped the escape hatches out of the other three
 * because each guarantees state the app cannot run without — a bound board, a
 * chosen drawing. This one asks for a password to somebody else's service, and
 * nobody may be compelled to type that. It also asks a question that is simply
 * false for some climbers: we cannot detect whether an account exists (there is no
 * lookup-by-email anywhere in Aurora's API), so plenty of people will be looking at
 * a card about something they don't have.
 */

export type ShouldOfferLinkInput = {
  /** The flag gate. A positive rollout flag, so unresolved reads as "don't". */
  enabled: boolean;
  /** The board just bound in the previous step. */
  boardType: string | undefined;
  /** No usable connection — a credential check would fail and the form can't submit. */
  isOffline: boolean;
  /** `undefined` while the persisted marker is still being read. */
  answered: boolean | undefined;
  /**
   * `undefined` while the credentials read is in flight. The credentials query is
   * `offlineFirst`, so this can stay unresolved indefinitely.
   */
  hasLinkedAccount: boolean | undefined;
};

/**
 * `wait` — not enough is known yet; ask again when the inputs change.
 * `none` — do nothing, this launch or ever.
 * `show` — present the step.
 */
export type ShouldOfferLinkDecision = 'wait' | 'none' | 'show';

/**
 * Order matters, cheapest and most certain `none`s first, so a climber who will
 * never see this step never waits on a network read to find that out.
 */
export function shouldOfferLink(input: ShouldOfferLinkInput): ShouldOfferLinkDecision {
  if (!input.enabled) return 'none';

  // MoonBoard is the important exclusion, not an edge case. It has no credential
  // flow at all: the only way in is a CSV the climber obtains by emailing Moon
  // Climbing a GDPR subject access request, which takes days. A card promising
  // their sends "in a few minutes" would be a straight lie, so MoonBoard climbers
  // are served by the empty-logbook prompt instead, which offers the import.
  if (!isLinkableBoard(input.boardType)) return 'none';

  // Offline the form cannot submit and the "already linked?" read cannot resolve,
  // so asking would burn the one-shot question on a screen that can't work. The
  // marker stays unwritten, so they are asked on a later launch instead.
  if (input.isOffline) return 'none';

  if (input.answered === undefined) return 'wait';
  if (input.answered) return 'none';

  // Never ask someone who already linked. Unresolved is `wait`, never `show`:
  // treating a pending read as "not linked" would put a first-run card in front of
  // a climber whose account has been connected for months.
  if (input.hasLinkedAccount === undefined) return 'wait';
  if (input.hasLinkedAccount) return 'none';

  return 'show';
}
