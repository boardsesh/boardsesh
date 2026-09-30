'use client';

import React from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import PauseRounded from '@mui/icons-material/PauseRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import { useTranslation } from 'react-i18next';
import { PageSection } from '@/app/components/ui/page-shell';
import { useAutoplayVideo } from '@/app/hooks/use-autoplay-video';
import { SHOWCASE_PHONE_MEDIA, showcaseVideoSources } from '@/app/lib/showcase-video';
import styles from './home-showcase-video.module.css';

/**
 * The homepage showcase: twenty seconds of the app on a wall, silent and looping.
 *
 * The video carries its own headlines as pixels, so the same words also render
 * as a visually hidden caption for screen readers and crawlers. The poster is a
 * `<picture>` layered under the video rather than the `poster` attribute,
 * because that attribute cannot be media-queried and a phone would download the
 * 16:9 image, then the 9:16 one. For the same reason the video has no `<source>`
 * list: `src` is picked on the client from the viewport and `canPlayType`, so
 * nothing is requested before the reader scrolls to it.
 */
export default function HomeShowcaseVideo() {
  const { t } = useTranslation('marketing');
  // A 1080p loop is heavy: start it only once a tenth of it is on screen.
  const { videoRef, showsControls, isPlaying, userPaused, toggleUserPaused } = useAutoplayVideo({
    rootMargin: '0px',
    threshold: 0.1,
  });
  const sources = React.useMemo(() => showcaseVideoSources(), []);
  const { wide, tall } = sources;

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const phoneQuery = window.matchMedia(SHOWCASE_PHONE_MEDIA);
    const format = video.canPlayType('video/webm') ? 'webm' : 'mp4';
    const applySource = () => {
      const nextSource = (phoneQuery.matches ? tall : wide)[format];
      if (video.getAttribute('src') === nextSource) return;
      const wasPlaying = !video.paused;
      video.src = nextSource;
      video.load();
      if (wasPlaying) void video.play().catch(() => undefined);
    };
    applySource();
    phoneQuery.addEventListener('change', applySource);
    return () => phoneQuery.removeEventListener('change', applySource);
  }, [videoRef, wide, tall]);

  const scenes = [
    { id: 'hook', headline: t('home.showcase.scenes.hook') },
    { id: 'light', headline: t('home.showcase.scenes.light') },
    { id: 'boards', headline: t('home.showcase.scenes.boards') },
    { id: 'crew', headline: t('home.showcase.scenes.crew') },
    { id: 'log', headline: t('home.showcase.scenes.log') },
    { id: 'outro', headline: t('home.showcase.scenes.outro') },
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
          data-active={isPlaying || showsControls ? 'true' : 'false'}
          aria-label={t('home.showcase.videoLabel')}
          muted
          loop
          playsInline
          preload="none"
          controls={showsControls}
        >
          {t('home.showcase.unsupported')}
        </video>
        {showsControls ? null : (
          <IconButton
            className={styles.toggle}
            size="small"
            aria-label={userPaused ? t('home.showcase.play') : t('home.showcase.pause')}
            onClick={toggleUserPaused}
          >
            {userPaused ? <PlayArrowRounded /> : <PauseRounded />}
          </IconButton>
        )}
        <Box component="figcaption" className={styles.sceneList}>
          <ul>
            {scenes.map((scene) => (
              <li key={scene.id}>{scene.headline}</li>
            ))}
          </ul>
        </Box>
      </Box>
      {/* Always rendered so the row never shifts the page when controls appear. */}
      <Typography
        variant="body2"
        className={showsControls ? styles.hint : `${styles.hint} ${styles.hintHidden}`}
        aria-hidden={showsControls ? undefined : true}
      >
        {t('home.showcase.playHint')}
      </Typography>
    </PageSection>
  );
}
