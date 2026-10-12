import { redactBoardInviteTokens, searchCarriesBoardInvite } from '../board-invite';

/**
 * Sentry event processor: a home board's share-link token never reaches an
 * error report, a transaction or a breadcrumb.
 *
 * The token rides in a page URL (`/b/{slug}?invite=…`) and, encoded, in the
 * sign-in page's `callbackUrl`, and Sentry copies URLs into `request.url`,
 * span attributes and navigation breadcrumbs. `sendDefaultPii: false` masks
 * only parameters whose NAMES look sensitive, and `invite` is not one of them.
 * One serialized pass covers every place a URL can land; an event that never
 * mentions an invite (nearly all of them) comes back untouched.
 */
export function redactBoardInviteFromEvent<TEvent>(event: TEvent): TEvent {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(event);
  } catch {
    return event;
  }
  if (!serialized || !searchCarriesBoardInvite(serialized)) return event;
  return JSON.parse(redactBoardInviteTokens(serialized)) as TEvent;
}
