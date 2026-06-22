import { useEffect } from 'react';
import { AppState } from 'react-native';
import { Image } from 'expo-image';
import { useIsAppBackgrounded } from '../lib/app-visibility';

/**
 * Sweep expo-image's in-memory decoded-bitmap cache + pool when the app
 * backgrounds, and on OS memory-pressure warnings.
 *
 * On-device profiling (Pixel 8 Pro, Android 16) showed the app holding board-art
 * bitmaps + GPU textures while backgrounded (the views stay mounted, so the
 * system can't reclaim them) — a background-kill risk on lower-RAM phones.
 * LayeredClimbImage blanks its <Image> layers on background (see
 * `useIsAppBackgrounded`), returning their bitmaps to expo-image's pool; this
 * sweep then frees the pool. The clear runs as a post-commit effect keyed on the
 * background flag so it fires AFTER the blank has committed — clearing first
 * would leave the still-mounted bitmaps referenced. The disk cache is untouched,
 * so foregrounding re-decodes from disk in tens of ms (no network).
 */
export function useImageCacheMemoryManagement(): void {
  const isBackgrounded = useIsAppBackgrounded();

  useEffect(() => {
    if (isBackgrounded) void Image.clearMemoryCache();
  }, [isBackgrounded]);

  useEffect(() => {
    const sub = AppState.addEventListener('memoryWarning', () => {
      void Image.clearMemoryCache();
    });
    return () => sub.remove();
  }, []);
}
