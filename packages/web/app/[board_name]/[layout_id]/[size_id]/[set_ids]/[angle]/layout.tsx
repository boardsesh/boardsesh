import React, { type PropsWithChildren } from 'react';
import Box from '@mui/material/Box';
import { headers } from 'next/headers';
import type { BoardRouteParameters } from '@/app/lib/types';
import {
  constructClimbListWithSlugs,
  layoutOwnsNumericSlugRedirect,
  tryConstructSlugListUrl,
} from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';
import { PATHNAME_HEADER } from '@/app/lib/request-pathname-header';
import { permanentRedirect } from 'next/navigation';
import { getBoardDetailsForBoard, generateBoardTitle } from '@/app/lib/board-utils';
import type { Metadata } from 'next';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { boardShellSx } from '@/app/components/climb-front-door/board-shell-sx';

export async function generateMetadata(props: { params: Promise<BoardRouteParameters> }): Promise<Metadata> {
  const params = await props.params;

  try {
    const { parsedParams } = await parseRouteParams(params);
    const boardDetails = getBoardDetailsForBoard(parsedParams);
    const title = generateBoardTitle(boardDetails);

    return {
      title,
    };
  } catch {
    // Fallback title if metadata generation fails
    const boardName = params.board_name.charAt(0).toUpperCase() + params.board_name.slice(1);
    return {
      title: `${boardName} | Boardsesh`,
    };
  }
}

type BoardLayoutProps = {
  params: Promise<BoardRouteParameters>;
};

/**
 * The board shell. Server-only: the session,
 * connection, queue and search providers came out with the sibling routes that
 * consumed them (#4433), and the pages left under it — the climb list and climb
 * view front doors — render server-side.
 */
export default async function BoardLayout(props: PropsWithChildren<BoardLayoutProps>) {
  const params = await props.params;

  const { children } = props;

  const { parsedParams, isNumericFormat } = await parseRouteParams(params);

  // Redirect old numeric URLs to new slug format — but not for the /view and
  // /play child routes, whose own pages redirect while preserving the climb
  // uuid. Redirecting those to the bare list here would drop the climb.
  const pathname = (await headers()).get(PATHNAME_HEADER) ?? '';
  if (isNumericFormat && layoutOwnsNumericSlugRedirect(pathname)) {
    const boardDetails = getBoardDetailsForBoard(parsedParams);

    if (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names) {
      // Id-aware first: the name-based builder only knows the bare size slug, so
      // a numeric URL for a size that shares one with another on the same layout
      // (Kilter layout 1 sizes 10/27) would 308 — and the browser caches that
      // permanently — onto the other board. Names remain the fallback for a
      // board the static tables don't carry.
      const newUrl =
        tryConstructSlugListUrl(
          parsedParams.board_name,
          parsedParams.layout_id,
          parsedParams.size_id,
          parsedParams.set_ids,
          parsedParams.angle,
        ) ??
        constructClimbListWithSlugs(
          boardDetails.board_name,
          boardDetails.layout_name,
          boardDetails.size_name,
          boardDetails.size_description,
          boardDetails.set_names,
          parsedParams.angle,
        );

      permanentRedirect(newUrl);
    }
  }

  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'climbs', 'session', 'boards', 'profile', 'feed']}>
      <Box sx={boardShellSx}>{children}</Box>
    </I18nProvider>
  );
}
