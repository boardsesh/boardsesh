import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { getBoardLayouts } from '@boardsesh/board-config';
import { PageShell, PageSection } from '@/app/components/ui/page-shell';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import StoreInstallButtons from '@/app/components/marketing/store-install-buttons';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { fetchFacetTotal } from '@/app/gyms/directory-data';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { WebsiteJourneyLink } from '@/app/components/marketing/website-journey-link';
import { compatibilityBoardSelected } from '@boardsesh/analytics';
import { themeTokens } from '@/app/theme/theme-config';

const boardRowSx = {
  display: 'grid',
  gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1.4fr)' },
  columnGap: 4,
  rowGap: 1,
  alignItems: 'start',
  py: 3,
  borderBottom: '1px solid var(--separator)',
};

const boardHeadingSx = {
  m: 0,
  fontSize: themeTokens.typography.fontSize.xl,
  fontWeight: themeTokens.typography.fontWeight.semibold,
  overflowWrap: 'anywhere' as const,
};

const actionSx = {
  display: 'inline-flex',
  alignItems: 'center',
  justifySelf: 'start',
  minHeight: 44,
  maxWidth: '100%',
  overflowWrap: 'anywhere' as const,
};

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('website');
  return createPageMetadata({ title: t('boardsTitle'), description: t('boardsDescription'), path: '/boards', locale });
}

export default async function SupportedBoardsPage() {
  const [{ t, locale }, labels] = await Promise.all([getServerTranslation('website'), getStoreButtonLabels()]);
  const counts = await Promise.all(
    SUPPORTED_BOARDS.filter((board) => board !== 'spray').map(async (board) => {
      return [board, await fetchFacetTotal([board])] as const;
    }),
  );
  const countsByBoard = new Map(counts);
  const numberFormat = new Intl.NumberFormat(locale);
  return (
    <PageShell title={t('boardsTitle')} lead={t('boardsLead')} width="wide">
      <Box component="ul" sx={{ listStyle: 'none', p: 0, my: 4, borderTop: '1px solid var(--separator)' }}>
        {SUPPORTED_BOARDS.map((board) => (
          <Box component="li" id={board} key={board} sx={boardRowSx}>
            <Typography component="h2" variant="h5" sx={boardHeadingSx}>
              {board === 'spray' ? t('sprayLabel') : boardTypeLabel(board)}
            </Typography>
            {board === 'spray' ? (
              <Typography component="p" sx={{ m: 0, color: 'text.secondary' }}>
                {t('sprayLayout')}
              </Typography>
            ) : (
              <Box
                component="ul"
                sx={{ listStyle: 'none', p: 0, m: 0, color: 'text.secondary', overflowWrap: 'anywhere' }}
              >
                {getBoardLayouts(board).map((layout) => (
                  <Typography component="li" key={layout.id}>
                    {layout.name}
                  </Typography>
                ))}
              </Box>
            )}
            <WebsiteJourneyLink
              href={localeHref(
                board === 'spray'
                  ? '/spraywalls'
                  : ['kilter', 'tension', 'moonboard'].includes(board)
                    ? `/gyms/${board}`
                    : `/gyms?boardType=${board}`,
                locale,
              )}
              event={compatibilityBoardSelected(board, 'board-compat')}
              underline="hover"
              sx={actionSx}
            >
              {board === 'spray' ? t('sprayRoute') : t('findGyms', { board: boardTypeLabel(board) })}
              {board !== 'spray' && countsByBoard.get(board) !== null
                ? ` · ${numberFormat.format(countsByBoard.get(board) ?? 0)}`
                : ''}
            </WebsiteJourneyLink>
          </Box>
        ))}
      </Box>
      <PageSection title={t('freeApp')}>
        <StoreInstallButtons placement="board-compat" labels={labels} align="start" />
        <MuiLink component={LocaleLink} href="/bring-your-logbook" sx={{ ...actionSx, mt: 2 }}>
          {t('importLink')}
        </MuiLink>
      </PageSection>
    </PageShell>
  );
}
