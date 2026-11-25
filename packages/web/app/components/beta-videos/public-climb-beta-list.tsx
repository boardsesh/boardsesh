import Box from '@mui/material/Box';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import { getServerTranslation } from '@/app/lib/i18n/server';
import type { BetaLink } from '@/app/lib/beta-video-url';
import { themeTokens } from '@/app/theme/theme-config';
import { betaLinkPlatform } from './beta-link-platform';
import { PublicBetaLink, PublicBetaThumbnail } from './public-beta-link';
import styles from './boardsesh-beta.module.css';

const PREVIEW_COUNT = 6;

/** The grid and translated text stay on the server; expansion needs no JavaScript. */
export default async function PublicClimbBetaList({ links }: { links: readonly BetaLink[] }) {
  const { t } = await getServerTranslation('common');
  const renderCards = (cards: readonly BetaLink[]) => (
    <Box component="ul" className={styles.grid}>
      {cards.map((link) => {
        const { displayPlatform, analyticsPlatform } = betaLinkPlatform(link.link);
        const handle = link.foreign_username ? `@${link.foreign_username}` : null;
        return (
          <Box component="li" key={link.link} className={styles.gridItem}>
            <PublicBetaLink
              href={link.link}
              climbUuid={link.climb_uuid}
              foreignUsername={link.foreign_username}
              platform={analyticsPlatform}
              className={styles.gridCard}
            >
              <Box component="span" className={styles.gridThumb}>
                {link.thumbnail ? <PublicBetaThumbnail src={link.thumbnail} className={styles.thumbnail} /> : null}
                <Box component="span" className={styles.playMark} aria-hidden>
                  <PlayArrowRounded fontSize="inherit" />
                </Box>
              </Box>
              <Box component="span" className={styles.gridText}>
                <Box component="span" className={styles.gridHandle}>
                  {handle ?? displayPlatform}
                </Box>
                {handle ? (
                  <Box component="span" className={styles.gridPlatform}>
                    {displayPlatform}
                  </Box>
                ) : null}
                <Box component="span" className={styles.gridWatch}>
                  {t('betaVideos.watch')}
                </Box>
              </Box>
            </PublicBetaLink>
          </Box>
        );
      })}
    </Box>
  );

  return (
    <Box className={styles.section} data-layout="grid">
      {renderCards(links.slice(0, PREVIEW_COUNT))}
      {links.length > PREVIEW_COUNT ? (
        <Box component="details" sx={{ mt: 1 }}>
          <Box
            component="summary"
            sx={{
              cursor: 'pointer',
              minHeight: 44,
              color: 'var(--color-primary)',
              fontWeight: themeTokens.typography.fontWeight.semibold,
            }}
          >
            {t('betaVideos.showAll', { total: links.length })}
          </Box>
          {renderCards(links.slice(PREVIEW_COUNT))}
        </Box>
      ) : null}
    </Box>
  );
}
