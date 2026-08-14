import React, { type PropsWithChildren } from 'react';
import { notFound } from 'next/navigation';
import { resolveBoardBySlug } from '@/app/lib/board-slug-utils';

type LayoutProps = {
  params: Promise<{ board_slug: string; angle: string }>;
};

export default async function BoardSlugListLayout(props: PropsWithChildren<LayoutProps>) {
  const params = await props.params;
  const { children } = props;

  // Resolve the board here so an unknown slug 404s at the layout rather than
  // rendering an empty page under it.
  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) {
    return notFound();
  }

  // No shell. This layout used to reach across trees for the legacy
  // `ListLayoutClient` — the A0 cross-tree blocker — and that component is
  // deleted with the queue/search sider it mounted.
  return <>{children}</>;
}
