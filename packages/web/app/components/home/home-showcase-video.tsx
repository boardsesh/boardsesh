'use client';

import React from 'react';
import { preload } from 'react-dom';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import PauseRounded from '@mui/icons-material/PauseRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import { useTranslation } from 'react-i18next';
import { useAutoplayVideo } from '@/app/hooks/use-autoplay-video';
import { track } from '@/app/lib/analytics';
import {
  SHOWCASE_CUT,
  SHOWCASE_POSTER_HEIGHT,
  SHOWCASE_POSTER_WIDTH,
  SHOWCASE_QUARTILE_THRESHOLDS,
  SHOWCASE_VIDEO_PROGRESS_EVENT,
  showcaseVideoSources,
  type ShowcaseQuartile,
  type ShowcaseVideoProgressProperties,
} from '@/app/lib/showcase-video';
import styles from './home-showcase-video.module.css';

/** Idle callbacks can starve on a busy main thread; start anyway after this long. */
const IDLE_TIMEOUT_MS = 3000;
/** Fallback delay where `requestIdleCallback` does not exist (Safari). */
const IDLE_FALLBACK_MS = 200;

/**
 * Runs `start` once the window has fired `load` and the main thread has gone
 * idle, so the video's bytes never compete with the poster (the page's main
 * paint) or the scripts that make the page interactive.
 */
function whenLoadedAndIdle(start: () => void): () => void {
  let cancelled = false;
  let idleHandle: number | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(() => start(), { timeout: IDLE_TIMEOUT_MS });
    } else {
      timeoutHandle = setTimeout(start, IDLE_FALLBACK_MS);
    }
  };

  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });

  return () => {
    cancelled = true;
    window.removeEventListener('load', run);
    if (idleHandle !== undefined && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleHandle);
    }
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  };
}

function readsDataSaver(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

/**
 * The hero video: a 9:16 demo of the app, silent and looping.
 *
 * The poster is a plain `<img>` (sized, high priority, decoded with the page)
 * because it is the largest thing in the first paint. The video sits on top of
 * it in the same box, invisible until its first frame plays, and gets no `src`
 * until the page has loaded and gone idle. Readers who save data or ask for
 * reduced motion keep the poster and get a play button.
 *
 * The video's headlines are burned into its pixels, so the same words render as
 * a visually hidden caption for screen readers and crawlers.
 */
export default function HomeShowcaseVideo() {
  const { t } = useTranslation('marketing');
  const sources = React.useMemo(() => showcaseVideoSources(), []);
  preload(sources.poster, { as: 'image', fetchPriority: 'high' });

  const [dataSaver, setDataSaver] = React.useState<boolean | null>(null);
  const [sourceReady, setSourceReady] = React.useState(false);
  const [videoPaused, setVideoPaused] = React.useState(true);
  const startedByReader = React.useRef(false);
  const reportedQuartiles = React.useRef(new Set<ShowcaseQuartile>());

  // The hook needs to know whether autoplay is allowed before it may touch the
  // video, so `enabled` follows the two values read below.
  const [autoplayAllowed, setAutoplayAllowed] = React.useState(false);
  const { videoRef, prefersReducedMotion, autoplayRefused, isPlaying, userPaused, toggleUserPaused } = useAutoplayVideo(
    {
      rootMargin: '0px',
      threshold: 0.1,
      enabled: autoplayAllowed && sourceReady,
    },
  );

  React.useEffect(() => {
    setDataSaver(readsDataSaver());
  }, []);

  const holdsAutoplay = dataSaver === true || prefersReducedMotion === true;
  React.useEffect(() => {
    setAutoplayAllowed(dataSaver === false && prefersReducedMotion === false);
  }, [dataSaver, prefersReducedMotion]);

  React.useEffect(() => {
    if (!autoplayAllowed) return;
    return whenLoadedAndIdle(() => setSourceReady(true));
  }, [autoplayAllowed]);

  const ensureSource = React.useCallback(
    (video: HTMLVideoElement) => {
      if (video.getAttribute('src')) return;
      video.src = video.canPlayType('video/webm') ? sources.webm : sources.mp4;
      video.preload = 'auto';
    },
    [sources],
  );

  // Layout effect so the source is in place before the hook's effect calls play().
  React.useLayoutEffect(() => {
    const video = videoRef.current;
    if (sourceReady && video) ensureSource(video);
  }, [sourceReady, videoRef, ensureSource]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const markPlaying = () => setVideoPaused(false);
    const markPaused = () => setVideoPaused(true);
    const reportProgress = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      const progress = video.currentTime / video.duration;
      for (const { quartile, progress: threshold } of SHOWCASE_QUARTILE_THRESHOLDS) {
        if (progress < threshold || reportedQuartiles.current.has(quartile)) continue;
        reportedQuartiles.current.add(quartile);
        const properties: ShowcaseVideoProgressProperties = {
          quartile,
          placement: 'hero',
          cut: SHOWCASE_CUT,
          autoplayed: !startedByReader.current,
        };
        track(SHOWCASE_VIDEO_PROGRESS_EVENT, properties);
      }
    };
    video.addEventListener('play', markPlaying);
    video.addEventListener('pause', markPaused);
    video.addEventListener('timeupdate', reportProgress);
    return () => {
      video.removeEventListener('play', markPlaying);
      video.removeEventListener('pause', markPaused);
      video.removeEventListener('timeupdate', reportProgress);
    };
  }, [videoRef]);

  const handleToggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      startedByReader.current = true;
      ensureSource(video);
      if (autoplayAllowed && userPaused) toggleUserPaused();
      void video.play().catch(() => undefined);
    } else {
      if (autoplayAllowed && !userPaused) toggleUserPaused();
      video.pause();
    }
  };

  const scenes = [
    { id: 'hook', headline: t('home.showcase.scenes.hook') },
    { id: 'light', headline: t('home.showcase.scenes.light') },
    { id: 'boards', headline: t('home.showcase.scenes.boards') },
    { id: 'wall', headline: t('home.showcase.scenes.wall') },
    { id: 'crew', headline: t('home.showcase.scenes.crew') },
    { id: 'workouts', headline: t('home.showcase.scenes.workouts') },
    { id: 'island', headline: t('home.showcase.scenes.island') },
    { id: 'log', headline: t('home.showcase.scenes.log') },
    { id: 'outro', headline: t('home.showcase.scenes.outro') },
  ];
  const idleWaitingForPlay = holdsAutoplay && !isPlaying && videoPaused;

  return (
    <Box component="figure" className={styles.figure}>
      <img
        className={styles.poster}
        src={sources.poster}
        width={SHOWCASE_POSTER_WIDTH}
        height={SHOWCASE_POSTER_HEIGHT}
        alt=""
        fetchPriority="high"
      />
      <video
        ref={videoRef}
        className={styles.video}
        data-active={isPlaying || autoplayRefused ? 'true' : 'false'}
        aria-label={t('home.showcase.videoLabel')}
        muted
        loop
        playsInline
        preload="none"
        controls={autoplayRefused}
      >
        {t('home.showcase.unsupported')}
      </video>
      <IconButton
        className={idleWaitingForPlay ? styles.toggleCentered : styles.toggle}
        size={idleWaitingForPlay ? 'large' : 'small'}
        aria-label={videoPaused ? t('home.showcase.play') : t('home.showcase.pause')}
        onClick={handleToggle}
      >
        {videoPaused ? <PlayArrowRounded /> : <PauseRounded />}
      </IconButton>
      <Box component="figcaption" className={styles.sceneList}>
        <ul>
          {scenes.map((scene) => (
            <li key={scene.id}>{scene.headline}</li>
          ))}
        </ul>
      </Box>
    </Box>
  );
}
