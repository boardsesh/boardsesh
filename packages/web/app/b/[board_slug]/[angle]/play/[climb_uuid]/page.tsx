import { notFound } from 'next/navigation';
import { resolveBoardBySlug, boardToRouteParamsFromAngleSegment } from '@/app/lib/board-slug-utils';
import { getClimb } from '@/app/lib/data/queries';
import { constructBoardSlugViewUrl, extractUuidFromSlug, isUuidOnly } from '@/app/lib/url-utils';
import { redirectWithQuery } from '@/app/lib/url-utils.server';

/**
 * Old `/b/{board_slug}/{angle}/play/[climb_uuid]` URLs 301-redirect to the
 * equivalent `/b/{board_slug}/{angle}/view/[climb_uuid]`. See the canonical
 * redirect page for context.
 */
export default async function BoardSlugPlayRedirectPage(props: {
  params: Promise<{ board_slug: string; angle: string; climb_uuid: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;

  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) return notFound();

  const parsedBoardParams = boardToRouteParamsFromAngleSegment(board, params.angle);
  if (!parsedBoardParams) return notFound();
  const angle = parsedBoardParams.angle;
  const climbUuid = extractUuidFromSlug(params.climb_uuid);

  // `extractUuidFromSlug` returns its input verbatim when no 32-hex-char UUID
  // is embedded. Redirecting /view/<garbage> would 301-cache the junk URL —
  // 404 instead so search indexes drop it.
  if (!isUuidOnly(climbUuid)) {
    notFound();
  }

  // Look up the climb name so the slug-prefixed view URL is preserved.
  let climbName: string | undefined;
  try {
    const parsedParams = { ...parsedBoardParams, climb_uuid: climbUuid };
    const climb = await getClimb(parsedParams);
    climbName = climb?.name ?? undefined;
  } catch {
    climbName = undefined;
  }

  const viewUrl = constructBoardSlugViewUrl(params.board_slug, angle, climbUuid, climbName);
  redirectWithQuery(viewUrl, searchParams);
}
