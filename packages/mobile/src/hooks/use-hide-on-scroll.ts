import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/**
 * Only the Android phone nav bar hides on scroll (`use-hide-on-scroll.android.ts`
 * reports offsets). On iOS and the web a tab root's `onScroll` is just the
 * handler it already had, and a list that had none still gets none.
 */
export function useHideOnScroll(forward?: (event: ScrollEvent) => void): ((event: ScrollEvent) => void) | undefined {
  return forward;
}
