import 'server-only';
import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import PlaylistPlayOutlined from '@mui/icons-material/PlaylistPlayOutlined';
import GroupsOutlined from '@mui/icons-material/GroupsOutlined';
import MenuBookOutlined from '@mui/icons-material/MenuBookOutlined';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { PageSection } from '@/app/components/ui/page-shell';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL } from '@/app/lib/store-urls';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import styles from './home-feature-strip.module.css';

/**
 * "Board night, sorted" — shared queue, party mode, logbook.
 *
 * A server component: this is marketing copy, so it has to be in the first
 * server-rendered HTML a crawler sees, and nothing here needs the browser. The
 * store links are real anchors rather than click handlers for the same reason.
 *
 * The captures show the real app, never generated imagery or another feature
 * standing in for the queue. Images are not upscaled past their natural size.
 * They go through `resolveStaticAssetUrl`, so production serves the immutable
 * object and a preview still reads the file straight out of `public/`.
 */

// Hoisted: brandCtaSx returns a plain object, so building it per render would
// allocate a new one for nothing. The amber glow belongs to the hero's one CTA
// and is deliberately not taken here.
const APP_CTA_SX = brandCtaSx({ size: 'large' });

/** Captures keep their device aspect ratio rather than stretching controls. */
const SHOT_HEIGHT = 1312;

/** One column's worth of the strip, once the copy is resolved. */
type FeatureColumn = {
  id: string;
  icon: React.ReactElement;
  /** The quiet violet-slate chip role, for the column that is not about the crew. */
  quietChip?: boolean;
  title: string;
  body: string;
  shot: { src: string; alt: string; width: number };
};

export default async function HomeFeatureStrip() {
  const { t } = await getServerTranslation('marketing');

  const columns: FeatureColumn[] = [
    {
      id: 'queue',
      icon: <PlaylistPlayOutlined />,
      title: t('home.features.queue.title'),
      body: t('home.features.queue.body'),
      shot: {
        src: resolveStaticAssetUrl('/images/app/shared-queue.webp'),
        alt: t('home.features.queue.shotAlt'),
        width: 603,
      },
    },
    {
      id: 'party',
      icon: <GroupsOutlined />,
      title: t('home.features.party.title'),
      body: t('home.features.party.body'),
      shot: {
        src: resolveStaticAssetUrl('/images/app/party-mode-crew.webp'),
        alt: t('home.features.party.shotAlt'),
        width: 738,
      },
    },
    {
      id: 'logbook',
      icon: <MenuBookOutlined />,
      quietChip: true,
      title: t('home.features.logbook.title'),
      body: t('home.features.logbook.body'),
      shot: {
        src: resolveStaticAssetUrl('/images/app/logbook-progress.webp'),
        alt: t('home.features.logbook.shotAlt'),
        width: 738,
      },
    },
  ];

  return (
    <Box className={styles.strip}>
      <PageSection className={styles.section} title={t('home.features.title')} lead={t('home.features.lead')}>
        <Box component="ul" className={styles.grid}>
          {columns.map((column) => (
            <Box component="li" key={column.id} className={styles.feature} data-testid="home-feature-column">
              <Box className={styles.featureCopy}>
                <Box className={`${styles.chip} ${column.quietChip ? styles.chipInfo : ''}`} aria-hidden>
                  {column.icon}
                </Box>
                <Typography variant="h5" component="h3" className={styles.featureTitle}>
                  {column.title}
                </Typography>
                <Typography variant="body1" component="p" className={styles.featureBody}>
                  {column.body}
                </Typography>
              </Box>
              <Box className={styles.shot}>
                <Image
                  src={column.shot.src}
                  alt={column.shot.alt}
                  width={column.shot.width}
                  height={SHOT_HEIGHT}
                  className={styles.shotImage}
                  sizes="(max-width: 760px) 128px, 190px"
                />
              </Box>
            </Box>
          ))}
        </Box>

        <Box className={styles.cta}>
          <Button
            variant="contained"
            size="large"
            sx={APP_CTA_SX}
            href={IOS_APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('home.features.cta')}
          </Button>
          <MuiLink href={ANDROID_PLAY_STORE_URL} target="_blank" rel="noopener noreferrer" underline="hover">
            {t('home.features.ctaAndroid')}
          </MuiLink>
        </Box>
      </PageSection>
    </Box>
  );
}
