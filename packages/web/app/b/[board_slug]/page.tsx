import { notFound, redirect } from 'next/navigation';
import type { GymQrSearchParams } from '@boardsesh/analytics';
import { resolveBoardBySlug } from '@/app/lib/board-slug-utils';
import { gymQrAttributionQuery } from '@/app/lib/gym-attribution';

type BoardSlugPageParams = {
  board_slug: string;
};

type BoardSlugPageProps = {
  params: Promise<BoardSlugPageParams>;
  searchParams: Promise<GymQrSearchParams>;
};

/**
 * Redirect /b/[slug] → /b/[slug]/{board.angle}/list
 * When no angle is specified in the URL, use the board's configured default angle.
 *
 * The target used to be a bare template string, which dropped the entire query
 * — including the `?src=qr&medium=kiosk` a scanned kiosk code carries, so a
 * kiosk scan reached the board list with no trace of where it came from.
 * `gymQrAttributionQuery` re-emits only `src` and `medium`, and only after the
 * contract's parser has accepted both, so nothing else a crafted link carries
 * rides through the hop. It returns `''` for an ordinary visit, so the clean
 * URL stays clean.
 *
 * The slug is percent-encoded for the same reason `gymQrUrl` encodes it: now
 * that a query rides behind the slug, a `#` in one would open a fragment and
 * swallow the params. Board slugs are generated, so this is a guard rather than
 * a fix — but the printed URL and the redirect that carries it must agree.
 *
 * This redirect must stay a 307 (temporary), even for the clean, no-attribution
 * case: the target embeds `board.angle`, a live DB field any board editor can
 * change via the `updateBoard` mutation (see `isAngleAdjustable` in
 * `packages/backend/src/graphql/resolvers/social/boards.ts`). A 308 is cached
 * by browsers indefinitely — Server Components can't attach cache-control
 * headers to `permanentRedirect` — so a visitor who followed a permanent
 * redirect before a gym re-angled its board would be pinned to a stale
 * `/b/{slug}/<old-angle>/list` forever. This hop is ~1 request/day in prod, so
 * the crawl-cost win from caching it isn't worth that risk. (Considered and
 * rejected in QA review on #4667.)
 */
export default async function BoardSlugPage(props: BoardSlugPageProps) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const board = await resolveBoardBySlug(params.board_slug);

  if (!board) {
    return notFound();
  }

  const listPath = `/b/${encodeURIComponent(board.slug)}/${board.angle}/list`;
  redirect(`${listPath}${gymQrAttributionQuery(searchParams)}`);
}
