import { useQuery } from '@tanstack/react-query';
import {
  BETA_LINK_PREVIEW,
  type BetaLinkPreviewQueryResponse,
  type BetaLinkPreviewQueryVariables,
} from '@boardsesh/graphql/operations/beta-links';
import { getHttpClient } from '../client';

/**
 * Live preview of a shared Instagram/TikTok URL (thumbnail + caption) for the
 * share flow, so the screen can auto-match the climb from the caption. Best
 * effort — `retry: false` because a transient IG block shouldn't hammer the
 * endpoint, and the screen falls back to the manual picker when this is empty.
 *
 * Standalone (not in the hooks barrel) so it stays importable without pulling
 * react-native into unit tests.
 */
export function useBetaLinkPreview(link: string | undefined) {
  return useQuery({
    queryKey: ['betaLinkPreview', link],
    queryFn: () =>
      getHttpClient().request<BetaLinkPreviewQueryResponse, BetaLinkPreviewQueryVariables>(BETA_LINK_PREVIEW, {
        link: link!,
      }),
    select: (data) => data.betaLinkPreview,
    enabled: !!link,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}
