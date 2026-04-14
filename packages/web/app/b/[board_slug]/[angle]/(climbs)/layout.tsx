import React from 'react';
import { PropsWithChildren } from 'react';
import { notFound } from 'next/navigation';
import { resolveBoardBySlug, boardToRouteParams } from '@/app/lib/board-slug-utils';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import ListLayoutClient from '@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/(climbs)/layout-client';

interface LayoutProps {
  params: Promise<{ board_slug: string; angle: string }>;
}

export default async function BoardSlugClimbsLayout(props: PropsWithChildren<LayoutProps>) {
  const params = await props.params;
  const { children } = props;

  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) {
    return notFound();
  }

  const parsedParams = boardToRouteParams(board, Number(params.angle));
  const boardDetails = getBoardDetailsForBoard(parsedParams);

  return <ListLayoutClient boardDetails={boardDetails}>{children}</ListLayoutClient>;
}
