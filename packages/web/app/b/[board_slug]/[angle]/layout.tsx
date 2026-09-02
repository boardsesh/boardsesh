import React, { type PropsWithChildren } from 'react';
import Box from '@mui/material/Box';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { resolveBoardBySlug } from '@/app/lib/board-slug-utils';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { boardShellSx } from '@/app/components/climb-front-door/board-shell-sx';

type BoardSlugRouteParams = {
  board_slug: string;
  angle: string;
};

export async function generateMetadata(props: { params: Promise<BoardSlugRouteParams> }): Promise<Metadata> {
  const params = await props.params;

  try {
    const board = await resolveBoardBySlug(params.board_slug);
    if (!board) {
      return { title: 'Board Not Found | Boardsesh' };
    }

    return {
      title: `${board.name} | Boardsesh`,
    };
  } catch {
    return { title: 'Boardsesh' };
  }
}

/**
 * The named-board shell. Server-only: the
 * board, session, connection, queue and search providers came out with the
 * sibling routes that consumed them (#4433), and the pages left under it — the
 * climb list and climb view front doors — render server-side.
 */
export default async function BoardSlugLayout(props: PropsWithChildren<{ params: Promise<BoardSlugRouteParams> }>) {
  const params = await props.params;
  const { children } = props;

  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) {
    return notFound();
  }

  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'climbs', 'session', 'boards', 'profile', 'feed']}>
      <Box sx={boardShellSx}>{children}</Box>
    </I18nProvider>
  );
}
