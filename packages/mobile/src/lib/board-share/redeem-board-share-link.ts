import {
  GET_BOARD_SHARE_LINK_PREVIEW,
  REDEEM_BOARD_SHARE_LINK,
  type BoardShareLinkRedemption,
} from '@boardsesh/graphql/operations/privacy';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import { fetchBoardByUuid } from '../graphql/hooks/fetch-board-by-uuid';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../auth-store';
import { extractGraphqlCode } from '../graphql/extract-error-message';

/**
 * The server's verdicts on this link: it opens nothing for this climber. Any
 * other refusal (a rate limit, a database hiccup) is worth one more try before
 * the link is treated as a plain board link.
 */
const FINAL_REFUSALS = new Set(['NOT_FOUND', 'PRIVACY_UNAVAILABLE', 'UNAUTHENTICATED', 'FORBIDDEN', 'BAD_USER_INPUT']);
const RETRY_DELAY_MS = 1500;

async function requestRedemption(token: string): Promise<BoardShareLinkRedemption> {
  return (
    await getHttpClient().request<{ redeemBoardShareLink: BoardShareLinkRedemption }>(REDEEM_BOARD_SHARE_LINK, {
      token,
    })
  ).redeemBoardShareLink;
}

/** Redeem, with one retry for a refusal that is not the server's final word. `null` when it opens nothing. */
async function redeemWithOneRetry(token: string, canContinue: () => boolean): Promise<BoardShareLinkRedemption | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!canContinue()) return null;
    try {
      return await requestRedemption(token);
    } catch (redeemError) {
      const code = extractGraphqlCode(redeemError);
      // No code at all is a transport failure: the fallback's own request will
      // say so, and the route's reconnect watcher retries the whole resolve.
      if (code === null || FINAL_REFUSALS.has(code) || attempt === 1) return null;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return null;
}

/**
 * Open a board share link (`/b/{slug}?invite={token}`) for the signed-in
 * climber: preview its name, ask them to join, then read it as the member they now
 * are.
 *
 * The board comes back by the uuid the server redeemed, not by the URL's slug.
 * The token is the capability and names exactly one board; a renamed board's old
 * slug, or a slug someone edited into the link, cannot point it anywhere else.
 *
 * A refusal (revoked or unknown link, a climber the owner removed, privacy
 * controls off) is not a dead end: the URL is still an ordinary board link, so
 * it resolves the way it would without the token, through `fallback`. So does
 * no signal: a board already on the device still opens, and when nothing local
 * matches the fallback's own request fails, which leaves the route's reconnect
 * watcher to run the whole resolve, redemption included, once there is signal.
 *
 * The token is sent in the request and never logged: the errors caught here are
 * not reported, because a graphql-request error carries its variables. A rate
 * limit or server error gets one retry before the fallback.
 */
export async function fetchBoardFromShareLink(
  token: string,
  slug: string,
  fallback: (slug: string) => Promise<UserBoard | null>,
  confirmJoin: ((boardName: string) => Promise<boolean>) | undefined,
  routeIsCurrent: () => boolean = () => true,
): Promise<UserBoard | null> {
  const credentialGeneration = captureAuthCredentialGeneration();
  const canContinue = () => routeIsCurrent() && isAuthCredentialGenerationCurrent(credentialGeneration);
  const resolveFallback = async () => {
    const board = await fallback(slug);
    return canContinue() ? board : null;
  };
  if (!canContinue()) return null;
  let preview: { name: string } | null;
  try {
    preview = (
      await getHttpClient().request<{ boardShareLinkPreview: { name: string } | null }>(GET_BOARD_SHARE_LINK_PREVIEW, {
        token,
      })
    ).boardShareLinkPreview;
  } catch {
    // graphql-request errors carry the token: never report them.
    return canContinue() ? resolveFallback() : null;
  }
  if (!canContinue()) return null;
  if (!preview || !confirmJoin) return resolveFallback();
  const confirmed = await confirmJoin(preview.name);
  // A delayed alert must never join under a different account or after the
  // person navigated away. Every retry rechecks the same scope.
  if (!canContinue()) return null;
  if (!confirmed) return resolveFallback();
  const redemption = await redeemWithOneRetry(token, canContinue);
  // Signed out or switched accounts mid-request: the grant belongs to whoever
  // sent it, and this route must not adopt a board for someone else.
  if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return null;
  if (!redemption) return resolveFallback();
  const board = await fetchBoardByUuid(redemption.boardUuid);
  return canContinue() ? board : null;
}
