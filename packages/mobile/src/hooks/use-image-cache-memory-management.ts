import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { Image } from 'expo-image';
import { useSegments } from 'expo-router';
import { useIsAppBackgrounded } from '../lib/app-visibility';
import { useDeviceLayout } from './use-device-layout';
import { tabsActiveSegment } from '../lib/route-segments';

/**
 * Ceiling for expo-image's in-memory decoded-bitmap cache, in bytes.
 *
 * 256 MB ≈ 32 full-resolution board-art overlays (a native-width overlay decodes
 * at roughly 8 MB of RGBA — `allowDownscaling={false}` on both LayeredClimbImage
 * layers means the bitmap is never resampled down), or several hundred list
 * thumbnails. That is far more than any surface holds at once — the play-drawer
 * carousel's widest working set is three (previous, current, peek) — so the cap
 * cannot evict art a live surface is about to swap to, while still bounding a
 * multi-day session at a fraction of the per-app memory budget on the 4 GB
 * iPhones where #3479 actually reproduced.
 */
export const IMAGE_MEMORY_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Ceiling for expo-image's ON-DISK cache, in bytes (issue #3647).
 *
 * `ImageCacheConfig.maxDiskSize` "defaults to 0, which means there is no cache
 * size limit" and nothing ever set it, so until now every `memory-disk` surface
 * — LayeredClimbImage, PlaylistBoardBackdrop, feed and beta cards — wrote into a
 * cache bounded only by SDWebImage's 7-day age default. That is the genuinely
 * unbounded cache on this device: `{cache}/board-thumbnails` has had a 200 MB cap
 * in the native renderer all along.
 *
 * Board art (LayeredClimbImage, PlaylistBoardBackdrop) has since moved to
 * `cachePolicy="memory"` (issue #5187): those PNGs are files we already own on
 * disk, so a second SDWebImage disk copy was duplicate I/O on a serial queue.
 * This disk cache is now fed only by the photo surfaces — feed, beta,
 * avatars — that still ask for `memory-disk`.
 *
 * 150 MB is several thousand list thumbnails and a few hundred full-width photos
 * — far past a session's working set, so the cap bites on accumulation rather
 * than on use, and what it evicts re-downloads only if you scroll back to it.
 *
 * Two caveats worth knowing before reading this as an instantaneous cap:
 * `ImageCacheConfig` is `@platform ios` (Android runs on Glide, which bounds its
 * own disk cache by its device-derived policy), and SDWebImage enforces the
 * ceiling during its background/terminate cleanup rather than continuously — so
 * the bound is real but lagging.
 */
export const IMAGE_DISK_CACHE_MAX_BYTES = 150 * 1024 * 1024;

// Bound and reclaim expo-image's in-memory decoded-bitmap cache.
//
// The ceiling is the load-bearing part. SDWebImage ships `maxMemoryCost = 0`
// (unlimited) and expo-image never overrides it, so until this hook set one the
// app ran an UNBOUNDED image memory cache: every distinct board-art bitmap a
// session decoded stayed resident until the app backgrounded or the OS fired a
// memory warning — and on iOS that warning arrives only after an allocation has
// already failed, which is the #3803 crash (SIGSEGV inside image decode) and the
// same shape as the 4 GB-iPhone foreground OOM in #3479. NSCache enforces the cap
// continuously, with no timer and no navigation seam to wait for, and eviction
// drops only the CACHE's reference: a bitmap a mounted view still displays is
// retained by that view (UIImageView.image + CALayer.contents), so trimming can
// never blank on-screen art or trigger a reload.
//
// The two sweeps below stay as they are. They reclaim at moments the cap can't
// see (going to background frees the whole working set, not just the excess) and
// they cost nothing once the cap is in place. The disk cache is untouched
// throughout, so anything evicted re-decodes from disk in tens of ms, no network.
export function useImageCacheMemoryManagement(): void {
  const isBackgrounded = useIsAppBackgrounded();

  // iOS-only. expo-image declares `configureCache` `@platform ios` and its Android
  // module defines no such function, so calling it off iOS fails at the bridge
  // rather than quietly no-opping. Android bounds Glide by its own
  // device-RAM-derived policy plus the native `modules/memory-trim` full-clear
  // (docs/react-native-performance.md §7); web has no native cache to configure.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    Image.configureCache({
      maxMemoryCost: IMAGE_MEMORY_CACHE_MAX_BYTES,
      maxDiskSize: IMAGE_DISK_CACHE_MAX_BYTES,
    });
  }, []);

  useEffect(() => {
    if (isBackgrounded) void Image.clearMemoryCache();
  }, [isBackgrounded]);

  useEffect(() => {
    const sub = AppState.addEventListener('memoryWarning', () => {
      void Image.clearMemoryCache();
    });
    // React Native Web does not implement the native memoryWarning event and
    // returns no subscription. The background sweep above still works there.
    return () => sub?.remove();
  }, []);
}

// Sweep expo-image's in-memory decoded-bitmap cache on every iPad top-level tab
// switch. The iPad shell keeps every tab mounted (`detachInactiveScreens={false}`,
// for the #3153 re-attach cost), so a long foreground session accumulates decoded
// board art from every tab that the background / memoryWarning sweeps never reach:
// an iPad kept open for days never backgrounds, and the OS memory warning can
// arrive only after an allocation has already failed — the #3803 crash pattern
// (SIGSEGV mid image-decode, ~3.7 days uptime). Clearing on tab change bounds that
// growth at a natural seam; the disk cache is untouched, so the incoming tab
// re-decodes in tens of ms. iPhone opts out (its tabs freeze/detach on blur, and a
// clear on every switch would needlessly re-decode the destination's art).
export function useIpadTabSwitchImageCacheSweep(): void {
  const { isPad } = useDeviceLayout();
  const segments = useSegments();
  const activeTab = tabsActiveSegment(segments);
  const lastTab = useRef<string | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    // Seed the first observation so mounting never sweeps — only a genuine
    // tab-to-tab change should clear the cache. A pushed sub-route inside a tab
    // keeps `activeTab` the same (tabsActiveSegment reads segment 1), so
    // navigating within a tab doesn't sweep.
    if (!seeded.current) {
      seeded.current = true;
      lastTab.current = activeTab;
      return;
    }
    if (activeTab === lastTab.current) return;
    lastTab.current = activeTab;
    if (isPad) void Image.clearMemoryCache();
  }, [activeTab, isPad]);
}
