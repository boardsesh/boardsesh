import { notFound } from 'next/navigation';
import type { BoardRouteParametersWithUuid } from '@/app/lib/types';
import { parseRouteParams, redirectWithQuery } from '@/app/lib/url-utils.server';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getClimb } from '@/app/lib/data/queries';
import {
  constructClimbViewUrl,
  constructClimbViewUrlWithSlugs,
  isUuidOnly,
  tryConstructSlugViewUrl,
} from '@/app/lib/url-utils';

/**
 * Old `/play/[climb_uuid]` URLs 301-redirect to the equivalent `/view/[climb_uuid]`.
 * The standalone play page is gone; the play-view drawer is the single climb
 * surface and handles multi-frame playback inline. Bookmarks and shared links
 * keep working through this redirect.
 */
export default async function PlayRedirectPage(props: {
  params: Promise<BoardRouteParametersWithUuid>;
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;

  const { parsedParams } = await parseRouteParams(params);

  // `parseRouteParams` runs the climb_uuid through `extractUuidFromSlug`,
  // which passes garbage through verbatim when no embedded UUID is found.
  // Redirecting that to /view/<garbage> would 301-cache a junk URL forever
  // and pollute search indexes — 404 instead.
  if (!isUuidOnly(parsedParams.climb_uuid)) {
    notFound();
  }

  const boardDetails = getBoardDetailsForBoard(parsedParams);

  // Look up the climb name so the slug-prefixed view URL is preserved.
  // If the climb can't be resolved we still redirect — just without the slug.
  let climbName: string | undefined;
  try {
    const climb = await getClimb(parsedParams);
    climbName = climb?.name ?? undefined;
  } catch {
    climbName = undefined;
  }

  // Id-aware first: this page 308s EVERY form of the /play URL — including an
  // already-canonical qualified one — so building the target name-based would
  // permanently re-point a shadowed size (Kilter 12x12 without kickboard) at
  // the bare slug's first match, the other physical board.
  const viewUrl =
    tryConstructSlugViewUrl(
      parsedParams.board_name,
      parsedParams.layout_id,
      parsedParams.size_id,
      parsedParams.set_ids,
      parsedParams.angle,
      parsedParams.climb_uuid,
      climbName,
    ) ??
    (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names
      ? constructClimbViewUrlWithSlugs(
          parsedParams.board_name,
          boardDetails.layout_name,
          boardDetails.size_name,
          boardDetails.size_description,
          boardDetails.set_names,
          parsedParams.angle,
          parsedParams.climb_uuid,
          climbName,
        )
      : constructClimbViewUrl(parsedParams, parsedParams.climb_uuid, climbName));

  redirectWithQuery(viewUrl, searchParams);
}
