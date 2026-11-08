import { useCallback, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useIsFocused } from 'expo-router';
import { reportTabBarScroll, type TabBarScrollSourceSlot } from '../lib/tab-bar-visibility-store';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/**
 * A tab root's `onScroll`, composed with the handler the list already had.
 * Reports each offset to the tab-bar visibility store, tagged with this list
 * and whether its screen is focused, and forwards the event unchanged.
 *
 * The returned handler keeps one identity for the life of the list, so passing
 * it never re-renders rows. It sets no React state. iOS and the web use
 * `use-hide-on-scroll.ts`, which only forwards.
 */
export function useHideOnScroll(forward?: (event: ScrollEvent) => void): ((event: ScrollEvent) => void) | undefined {
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const forwardRef = useRef(forward);
  forwardRef.current = forward;
  const sourceRef = useRef<TabBarScrollSourceSlot['current']>(null);
  return useCallback((event: ScrollEvent) => {
    forwardRef.current?.(event);
    reportTabBarScroll(sourceRef, event.nativeEvent.contentOffset.y, focusedRef.current);
  }, []);
}
