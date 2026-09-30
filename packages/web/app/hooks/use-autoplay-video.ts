'use client';

import React from 'react';

/**
 * Whether the reader has asked their system for less motion.
 *
 * `null` until the client has looked, which is the state the server renders:
 * neither autoplay nor controls, just the poster in its frame. Resolving it on
 * the server is impossible and guessing it wrong is the expensive direction —
 * a looping video that starts itself is exactly what the setting exists to stop.
 */
function usePrefersReducedMotion(): boolean | null {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const read = () => setPrefersReducedMotion(query.matches);
    read();
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, []);

  return prefersReducedMotion;
}

type UseAutoplayVideoOptions = {
  /** Margin around the viewport inside which the video counts as "near". */
  rootMargin?: string;
  /** Share of the video that must be visible to count as in view. */
  threshold?: number;
  /**
   * When false the hook neither plays nor pauses, leaving the video to the
   * caller (for example until its source has been chosen). Defaults to true.
   */
  enabled?: boolean;
};

type UseAutoplayVideoResult = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** True for reduced-motion readers and when the browser refused autoplay. */
  showsControls: boolean;
  /** `null` until the client has looked. */
  prefersReducedMotion: boolean | null;
  /** True when the browser rejected `play()`. */
  autoplayRefused: boolean;
  /** True once the video has actually started producing frames. */
  isPlaying: boolean;
  /** True after the reader pressed pause; scrolling never restarts the video then. */
  userPaused: boolean;
  toggleUserPaused: () => void;
};

/**
 * Plays a silent looping video only while it is near the viewport.
 *
 * A page can carry several loops; playing them all on mount would download and
 * decode every one at once, most below the fold. Each plays while near the
 * viewport and pauses when it scrolls away. Reduced-motion readers never get
 * autoplay, and a refused `play()` (battery saver, a browser wanting a gesture
 * first) reveals the same native controls, so the video is never a dead rectangle.
 * A reader who pauses by hand stays paused (WCAG 2.2.2) until they press play.
 */
export function useAutoplayVideo({
  rootMargin = '200px 0px',
  threshold,
  enabled = true,
}: UseAutoplayVideoOptions = {}): UseAutoplayVideoResult {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [autoplayRefused, setAutoplayRefused] = React.useState(false);
  const [inView, setInView] = React.useState(false);
  const [userPaused, setUserPaused] = React.useState(false);
  const [isPlaying, setIsPlaying] = React.useState(false);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { rootMargin, threshold },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [rootMargin, threshold]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const markPlaying = () => setIsPlaying(true);
    // Not 'ended': a looping video never fires it. 'emptied' and 'error' cover a
    // source swap or failure, where the last frame is gone.
    const markStopped = () => setIsPlaying(false);
    video.addEventListener('playing', markPlaying);
    video.addEventListener('pause', markStopped);
    video.addEventListener('emptied', markStopped);
    video.addEventListener('error', markStopped);
    return () => {
      video.removeEventListener('playing', markPlaying);
      video.removeEventListener('pause', markStopped);
      video.removeEventListener('emptied', markStopped);
      video.removeEventListener('error', markStopped);
    };
  }, []);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!enabled || !video || prefersReducedMotion === null) return;
    if (prefersReducedMotion || !inView || userPaused) {
      video.pause();
      return;
    }
    void video.play().catch(() => setAutoplayRefused(true));
  }, [enabled, prefersReducedMotion, inView, userPaused]);

  const toggleUserPaused = React.useCallback(() => setUserPaused((paused) => !paused), []);

  return {
    videoRef,
    showsControls: prefersReducedMotion === true || autoplayRefused,
    prefersReducedMotion,
    autoplayRefused,
    isPlaying,
    userPaused,
    toggleUserPaused,
  };
}
