import React, { type PropsWithChildren } from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { resolveBoardBySlug, boardToRouteParams } from '@/app/lib/board-slug-utils';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';

import { constructBoardSlugListUrl } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';

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

  const angle = Number(params.angle);
  const parsedParams = boardToRouteParams(board, angle);

  const boardDetails = getBoardDetailsForBoard(parsedParams);

  const listUrl = constructBoardSlugListUrl(board.slug, angle);
  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'climbs', 'session', 'boards', 'profile', 'feed']}>
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          background: 'var(--semantic-surface)',
        }}
      >
        <main
          id="content-for-scrollable"
          style={{
            flex: 1,
            paddingLeft: `${themeTokens.spacing[2]}px`,
            paddingRight: `${themeTokens.spacing[2]}px`,
            paddingTop: 'var(--global-header-height)',
          }}
        >
          {children}
        </main>
      </div>
    </I18nProvider>
  );
}
