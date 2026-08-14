import React, { type PropsWithChildren } from 'react';

import type { BoardRouteParameters } from '@/app/lib/types';
import { constructClimbListWithSlugs, tryConstructSlugListUrl } from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { permanentRedirect } from 'next/navigation';

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

  // The queue/search sider this layout used to mount is gone with the rest of
  // the classic climbing UI (W-15); the page below is a server-rendered front
  // door and needs no shell. The module itself must survive, though: it carries
  // the (A2) numeric→slug redirect above, which
  // `crawler-classic-invariant.test.ts` imports and pins.
  return <>{children}</>;
}
