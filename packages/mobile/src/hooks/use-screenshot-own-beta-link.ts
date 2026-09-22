import { useEffect, useState } from 'react';
import {
  GET_USER_BETA_LINKS,
  type GetUserBetaLinksQueryResponse,
  type GetUserBetaLinksQueryVariables,
} from '@boardsesh/graphql/operations/beta-links';
import { isBetaVideoUrl } from '@boardsesh/shared-schema';
import { getHttpClient } from '../lib/graphql/client';
import { mapBetaLink } from '../lib/beta-video-url';

/**
 * The capture account's own most recent beta video link, for the `13-share-beta`
 * screenshot.
 *
 * `/share-beta` is normally entered through an OS share-sheet hand-off carrying a
 * post URL, which a Maestro flow cannot perform — so the capture reaches it by
 * deep link instead (see `.maestro/help.yaml`). The deep link deliberately
 * carries no URL: hardcoding a reel in the flow YAML would put a stranger's
 * thumbnail and caption on a published help page, and it would rot the same way a
 * hardcoded board id does. So the screen re-shares a link the account already
 * owns — a real link, really previewed, really matched against real ascents.
 *
 * Deliberately NOT `useUserBetaLinks(userId, 1, enabled)`. A hook call is not a
 * branch: babel-preset-expo folds the `enabled` argument to `false` in a normal
 * build, but the call itself survives minification, so every real climber opening
 * the share modal would still pay for that hook's five `useState`s, its refs and
 * its mount effect — and `startFresh()` calls `setVideos([])`, a fresh array
 * identity, so it costs re-renders on a screen carrying a virtualized ascent
 * feed. The whole fetch therefore lives inside an effect whose first statement is
 * the inlined `process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1'` comparison, which
 * folds to `false` and lets terser drop the body — the same shape, and the same
 * reasoning, as `use-screenshot-board-params.ts`. See the note at the top of
 * `lib/screenshot-mode.ts`.
 *
 * Returns `''` in every normal build, and in screenshot mode until the request
 * lands or when the account has no beta video at all.
 */
export function useScreenshotOwnBetaLink(userId: string | null | undefined, enabled: boolean): string {
  const [ownBetaLink, setOwnBetaLink] = useState('');

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' || !enabled || !userId) return;
    let cancelled = false;
    void getHttpClient()
      .request<GetUserBetaLinksQueryResponse, GetUserBetaLinksQueryVariables>(GET_USER_BETA_LINKS, {
        userId,
        limit: 1,
        offset: 0,
      })
      .then((response) => {
        if (cancelled) return;
        // `userBetaLinks` can hand back a non-video link (a blog post, a plain
        // photo); the share screen's preview only knows how to render a video, so
        // hold the empty string rather than show a dead card.
        const firstLink = response.userBetaLinks[0]?.betaLink;
        if (!firstLink) return;
        const mappedLink = mapBetaLink(firstLink).link;
        if (isBetaVideoUrl(mappedLink)) setOwnBetaLink(mappedLink);
      })
      .catch((error: unknown) => {
        // A capture is not a user session: swallowing this would leave the screen
        // holding on an empty link until Maestro's own timeout, with nothing in
        // the log to say why.
        console.error('[screenshot] failed to resolve the account’s own beta link:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, enabled]);

  return ownBetaLink;
}
