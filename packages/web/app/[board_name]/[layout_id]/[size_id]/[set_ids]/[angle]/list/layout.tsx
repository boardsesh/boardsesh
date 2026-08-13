import React, { type PropsWithChildren } from 'react';

import type { BoardRouteParameters } from '@/app/lib/types';
import { constructClimbListWithSlugs, tryConstructSlugListUrl } from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { permanentRedirect } from 'next/navigation';
import ListLayoutClient from './layout-client';

type LayoutProps = {
  params: Promise<BoardRouteParameters>;
};

export default async function ListLayout(props: PropsWithChildren<LayoutProps>) {
  const params = await props.params;

  const { children } = props;

  const { parsedParams, isNumericFormat } = await parseRouteParams(params);

  // Redirect old numeric URLs to the slug format. In production the parent
  // `[angle]/layout.tsx` owns this redirect and resolves first, so this copy is
  // a crawler-invariant backstop (pinned by crawler-classic-invariant.test.ts)
  // — but it must still build id-aware: a name-based target here would re-point
  // a shadowed size (Kilter 12x12 without kickboard) at the wrong board the day
  // a render-order change makes this layer reachable.
  if (isNumericFormat) {
    const boardDetails = getBoardDetailsForBoard(parsedParams);

    const idAwareUrl = tryConstructSlugListUrl(
      parsedParams.board_name,
      parsedParams.layout_id,
      parsedParams.size_id,
      parsedParams.set_ids,
      parsedParams.angle,
    );
    const newUrl =
      idAwareUrl ??
      (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names
        ? constructClimbListWithSlugs(
            boardDetails.board_name,
            boardDetails.layout_name,
            boardDetails.size_name,
            boardDetails.size_description,
            boardDetails.set_names,
            parsedParams.angle,
          )
        : null);

    if (newUrl) {
      permanentRedirect(newUrl);
    }
  }

  // Fetch the climbs and board details server-side
  const boardDetails = getBoardDetailsForBoard(parsedParams);

  return <ListLayoutClient boardDetails={boardDetails}>{children}</ListLayoutClient>;
}
