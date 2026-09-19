import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { PageSection } from '@/app/components/ui/page-shell';
import { MarketingScreenshot, type MarketingShot } from '@/app/components/marketing/marketing-screenshot';
import styles from './home-feature-strip.module.css';

/** The benefits stay server-rendered; only each image reads the shared preview choice. */
export default async function HomeFeatureStrip() {
  const { t } = await getServerTranslation('marketing');
  const features: { id: MarketingShot; title: string; body: string; alt: string }[] = [
    {
      id: 'queue',
      title: t('home.features.queue.title'),
      body: t('home.features.queue.body'),
      alt: t('home.features.queue.shotAlt'),
    },
    {
      id: 'wall-status',
      title: t('home.features.wall.title'),
      body: t('home.features.wall.body'),
      alt: t('home.features.wall.shotAlt'),
    },
    {
      id: 'profile',
      title: t('home.features.profile.title'),
      body: t('home.features.profile.body'),
      alt: t('home.features.profile.shotAlt'),
    },
  ];

  return (
    <Box className={styles.strip}>
      <PageSection className={styles.section} title={t('home.features.title')} lead={t('home.features.lead')}>
        <Box component="ul" className={styles.grid}>
          {features.map((feature) => (
            <Box component="li" key={feature.id} className={styles.feature} data-testid="home-feature-column">
              <Box className={styles.featureCopy}>
                <Typography component="h3" className={styles.featureTitle}>
                  {feature.title}
                </Typography>
                <Typography component="p" className={styles.featureBody}>
                  {feature.body}
                </Typography>
              </Box>
              <MarketingScreenshot shot={feature.id} alt={feature.alt} detail className={styles.shot} />
            </Box>
          ))}
        </Box>
      </PageSection>
    </Box>
  );
}
