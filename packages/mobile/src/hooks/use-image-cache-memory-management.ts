import { useEffect } from 'react';
import { AppState } from 'react-native';
import { Image } from 'expo-image';
import { useIsAppBackgrounded } from '../lib/app-visibility';

// Sweep expo-image's in-memory decoded-bitmap cache on background and on OS
// memory-pressure warnings. The foreground `memoryWarning` path is the direct
// lever against the iOS OOM watchdog kill on low-RAM devices (#3479); the disk
// cache is untouched, so foregrounding re-decodes from disk in tens of ms (no
// network). LayeredClimbImage blanks its <Image> layers on background first,
// returning their bitmaps to the pool this sweep then frees.
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
