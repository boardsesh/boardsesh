import React, { type PropsWithChildren } from 'react';
import Box from '@mui/material/Box';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { boardShellSx } from '@/app/components/climb-front-door/board-shell-sx';

/**
 * The named-board shell. Server-only: the
 * board, session, connection, queue and search providers came out with the
 * sibling routes that consumed them (#4433), and the pages left under it — the
 * climb list and climb view front doors — render server-side.
 *
 * It resolves no board and 404s nothing. A layout never sees the query string,
 * and an unlisted spray wall is only readable with the `?wall=` capability in
 * it: a slug-only lookup here 404'd every unlisted wall's share link before the
 * page could present the uuid. Every page under this layout resolves the board
 * itself (React `cache` dedupes the read) and answers `notFound()` for a miss,
 * and sets its own title.
 */
export default async function BoardSlugLayout(props: PropsWithChildren) {
  const { children } = props;
  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'climbs', 'session', 'boards', 'profile', 'feed']}>
      <Box sx={boardShellSx}>{children}</Box>
    </I18nProvider>
  );
}
