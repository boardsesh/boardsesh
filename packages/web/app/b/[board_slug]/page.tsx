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
