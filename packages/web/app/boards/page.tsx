import { isBoardTypeVisible } from '@boardsesh/board-config/visibility';
import { getBoardVisibilityFlags } from '@/app/lib/boards/board-visibility.server';
import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { AURORA_BOARDS, SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { getBoardCapabilities, getBoardLayouts } from '@boardsesh/board-config';
import { PageShell, PageSection, PageCard, Prose } from '@/app/components/ui/page-shell';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import StoreInstallButtons from '@/app/components/marketing/store-install-buttons';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { fetchFacetTotal } from '@/app/gyms/directory-data';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { WebsiteJourneyLink } from '@/app/components/marketing/website-journey-link';
import { compatibilityBoardSelected } from '@boardsesh/analytics';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('website');
  return createPageMetadata({ title: t('boardsTitle'), description: t('boardsLead'), path: '/boards', locale });
}

export default async function SupportedBoardsPage() {
  const [{ t, locale }, labels, visibilityFlags] = await Promise.all([
    getServerTranslation('website'),
    getStoreButtonLabels(),
    getBoardVisibilityFlags(),
  ]);
  const visibleBoards = SUPPORTED_BOARDS.filter(
    (board) => board !== 'spray' && isBoardTypeVisible(board, visibilityFlags),
  );
  const counts = await Promise.all(
    visibleBoards.map(async (board) => {
      return [board, await fetchFacetTotal([board])] as const;
    }),
  );
  const countsByBoard = new Map(counts);
  const numberFormat = new Intl.NumberFormat(locale);
  return (
    <PageShell title={t('boardsTitle')} lead={t('boardsLead')} width="wide">
      <Prose>{t('platforms')}</Prose>
      <Prose>{t('controller')}</Prose>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 3, my: 4 }}>
        {visibleBoards.map((board) => (
          <PageCard key={board}>
            <PageSection id={board} title={boardTypeLabel(board)}>
              <Typography component="h3" variant="subtitle1">
                {t('layouts')}
              </Typography>
              <Prose>
                {getBoardLayouts(board)
                  .map((layout) => layout.name)
                  .join(', ')}
              </Prose>
              <Typography component="h3" variant="subtitle1">
                {t('lights')}
              </Typography>
              <Prose>{getBoardCapabilities(board).nativeBoardControl ? t('nativeLights') : t('noLights')}</Prose>
              <Typography component="h3" variant="subtitle1">
                {t('imports')}
              </Typography>
              <Prose>
                {(AURORA_BOARDS as readonly string[]).includes(board)
                  ? t('auroraImport')
                  : board === 'moonboard'
                    ? t('moonboardImport')
                    : t('noImport')}
              </Prose>
              {board === 'kilter' ? <Prose>{t('legacyImport')}</Prose> : null}
              <WebsiteJourneyLink
                href={localeHref(
                  ['kilter', 'tension', 'moonboard'].includes(board) ? `/gyms/${board}` : `/gyms?boardType=${board}`,
                  locale,
                )}
                event={compatibilityBoardSelected(board, 'board-compat')}
                underline="hover"
                sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
              >
                {t('findGyms', { board: boardTypeLabel(board) })}
                {countsByBoard.get(board) !== null ? ` · ${numberFormat.format(countsByBoard.get(board) ?? 0)}` : ''}
              </WebsiteJourneyLink>
            </PageSection>
          </PageCard>
        ))}
      </Box>
      <PageSection title={t('sprayTitle')} lead={t('sprayNoLights')}>
        <MuiLink component={LocaleLink} href="/spraywalls">
          {t('sprayRoute')}
        </MuiLink>
      </PageSection>
      <PageSection title={t('freeApp')}>
        <StoreInstallButtons placement="board-compat" labels={labels} align="start" />
        <Prose>{t('checked')}</Prose>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, mt: 2 }}>
          <MuiLink component={LocaleLink} href="/help/board-and-bluetooth">
            {t('lights')}
          </MuiLink>
          <MuiLink component={LocaleLink} href="/bring-your-logbook">
            {t('importLink')}
          </MuiLink>
        </Box>
      </PageSection>
    </PageShell>
  );
}
