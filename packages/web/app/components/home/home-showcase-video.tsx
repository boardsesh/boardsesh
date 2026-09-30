'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { PageSection } from '@/app/components/ui/page-shell';
import { useAutoplayVideo } from '@/app/hooks/use-autoplay-video';
import { SHOWCASE_PHONE_MEDIA, showcaseVideoSources } from '@/app/lib/showcase-video';
import styles from './home-showcase-video.module.css';

/**
 * The homepage showcase: twenty seconds of the app on a wall, silent and looping.
 *
 * The video carries its own headlines as pixels, so the same words also render
 * as a visually hidden list for screen readers and crawlers. The poster is a
 * `<picture>` layered under the video rather than the `poster` attribute,
 * because that attribute cannot be media-queried and a phone would download the
 * 16:9 image, then the 9:16 one.
 */
export default function HomeShowcaseVideo() {
  const { t } = useTranslation('marketing');
  const { videoRef, showsControls } = useAutoplayVideo({ rootMargin: '200px 0px' });
  const { wide, tall } = showcaseVideoSources();
  const sceneHeadlines = [
    t('home.showcase.scenes.hook'),
    t('home.showcase.scenes.light'),
    t('home.showcase.scenes.boards'),
    t('home.showcase.scenes.crew'),
    t('home.showcase.scenes.log'),
    t('home.showcase.scenes.outro'),
  ];

  return (
    <PageSection className={styles.section} title={t('home.showcase.title')} lead={t('home.showcase.lead')}>
      <Box component="figure" className={styles.figure}>
        <picture className={styles.poster}>
          <source media={SHOWCASE_PHONE_MEDIA} srcSet={tall.poster} />
          <img src={wide.poster} alt="" decoding="async" />
        </picture>
        <video
          ref={videoRef}
          className={styles.video}
          aria-label={t('home.showcase.videoLabel')}
          muted
          loop
          playsInline
          preload="none"
          controls={showsControls}
        >
          {/* The phone cut first: a browser takes the first source whose media
              query matches and whose type it can play. */}
          <source src={tall.webm} type="video/webm" media={SHOWCASE_PHONE_MEDIA} />
          <source src={tall.mp4} type="video/mp4" media={SHOWCASE_PHONE_MEDIA} />
          <source src={wide.webm} type="video/webm" />
          <source src={wide.mp4} type="video/mp4" />
          {t('help.clip.unsupported')}
        </video>
        <ul className={styles.sceneList}>
          {sceneHeadlines.map((headline) => (
            <li key={headline}>{headline}</li>
          ))}
        </ul>
      </Box>
      {showsControls ? (
        <Typography variant="body2" className={styles.hint}>
          {t('help.clip.playHint')}
        </Typography>
      ) : null}
    </PageSection>
  );
}
