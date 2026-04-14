import React from 'react';

import { PropsWithChildren } from 'react';

import { BoardRouteParameters } from '@/app/lib/types';
import { constructClimbListWithSlugs } from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { permanentRedirect } from 'next/navigation';
import ListLayoutClient from './layout-client';

interface LayoutProps {
  params: Promise<BoardRouteParameters>;
}

export default async function ClimbsLayout(props: PropsWithChildren<LayoutProps>) {
  const params = await props.params;

  const { children } = props;

  const { parsedParams, isNumericFormat } = await parseRouteParams(params);

  // Redirect old numeric URLs to new slug format
  if (isNumericFormat) {
    const boardDetails = getBoardDetailsForBoard(parsedParams);

    if (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names) {
      const newUrl = constructClimbListWithSlugs(
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

  // Fetch the climbs and board details server-side
  const boardDetails = getBoardDetailsForBoard(parsedParams);

  return <ListLayoutClient boardDetails={boardDetails}>{children}</ListLayoutClient>;
}
