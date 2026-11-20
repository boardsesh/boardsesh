import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { PageShell, PageSection } from '@/app/components/ui/page-shell';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import StoreInstallButtons from '@/app/components/marketing/store-install-buttons';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { WebsiteJourneyLink } from '@/app/components/marketing/website-journey-link';
import { compatibilityBoardSelected } from '@boardsesh/analytics';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import BoardLayoutRail from './board-layout-rail';
import { getBoardGalleryLayouts } from './board-gallery';
import styles from './boards-gallery.module.css';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('website');
  return createPageMetadata({ title: t('boardsTitle'), description: t('boardsDescription'), path: '/boards', locale });
}

export default async function SupportedBoardsPage() {
  const [{ t, locale }, labels] = await Promise.all([getServerTranslation('website'), getStoreButtonLabels()]);
  return (
    <PageShell title={t('boardsTitle')} lead={t('boardsLead')} width="wide">
      <Box component="ul" role="list" className={styles.gallery}>
        {SUPPORTED_BOARDS.map((board) => {
          const layouts = board === 'spray' ? [] : getBoardGalleryLayouts(board);
          const multipleLayouts = layouts.length > 1;
          const headingId = `board-${board}-title`;
          const figures = layouts.map((layout, index) => (
            <Box component="li" key={layout.layoutId} className={styles.layout}>
              <Box component="figure" className={styles.figure}>
                <Box className={styles.stage}>
                  <img
                    src={resolveStaticAssetUrl(layout.src)}
                    width={layout.width}
                    height={layout.height}
                    alt={t('boardLayoutAlt', { board: boardTypeLabel(board), layout: layout.layoutName })}
                    loading={board === 'kilter' && index === 0 ? 'eager' : 'lazy'}
                    fetchPriority={board === 'kilter' && index === 0 ? 'high' : undefined}
                    className={styles.image}
                  />
                </Box>
                <Typography component="figcaption" className={styles.caption}>
                  {layout.caption}
                </Typography>
              </Box>
            </Box>
          ));
          return (
            <Box
              component="li"
              id={board}
              key={board}
              className={styles.panel}
              data-board={board}
              data-layouts={multipleLayouts ? 'multiple' : 'single'}
            >
              <Typography component="h2" variant="h5" id={headingId} className={styles.heading}>
                {board === 'spray' ? t('sprayLabel') : boardTypeLabel(board)}
              </Typography>
              {board === 'spray' ? (
                <Box component="figure" className={styles.figure}>
                  <Box className={styles.stage}>
                    <img
                      src={resolveStaticAssetUrl('/images/help/spray-wall-photo.webp')}
                      width={1752}
                      height={2047}
                      alt={t('sprayGalleryAlt')}
                      loading="lazy"
                      className={styles.image}
                    />
                  </Box>
                  <Typography component="figcaption" className={styles.caption}>
                    {t('sprayStep1')}
                  </Typography>
                </Box>
              ) : multipleLayouts ? (
                <BoardLayoutRail
                  labelledBy={headingId}
                  previousLabel={t('previousLayouts', { board: boardTypeLabel(board) })}
                  nextLabel={t('nextLayouts', { board: boardTypeLabel(board) })}
                >
                  {figures}
                </BoardLayoutRail>
              ) : (
                <Box component="ul" role="list" sx={{ listStyle: 'none', p: 0, m: 0 }}>
                  {figures}
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
                className={styles.action}
              >
                {board === 'spray' ? t('sprayRoute') : t('findGyms', { board: boardTypeLabel(board) })}
              </WebsiteJourneyLink>
            </Box>
          );
        })}
      </Box>
      <PageSection title={t('freeApp')}>
        <StoreInstallButtons placement="board-compat" labels={labels} align="start" />
        <MuiLink component={LocaleLink} href="/bring-your-logbook" className={styles.action}>
          {t('importLink')}
        </MuiLink>
      </PageSection>
    </PageShell>
  );
}
