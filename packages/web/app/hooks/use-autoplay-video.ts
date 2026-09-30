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
};

type UseAutoplayVideoResult = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** True for reduced-motion readers and when the browser refused autoplay. */
  showsControls: boolean;
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
    video.addEventListener('playing', markPlaying);
    return () => video.removeEventListener('playing', markPlaying);
  }, []);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || prefersReducedMotion === null) return;
    if (prefersReducedMotion || !inView || userPaused) {
      video.pause();
      return;
    }
    void video.play().catch(() => setAutoplayRefused(true));
  }, [prefersReducedMotion, inView, userPaused]);

  const toggleUserPaused = React.useCallback(() => setUserPaused((paused) => !paused), []);

  return {
    videoRef,
    showsControls: prefersReducedMotion === true || autoplayRefused,
    isPlaying,
    userPaused,
    toggleUserPaused,
  };
}
