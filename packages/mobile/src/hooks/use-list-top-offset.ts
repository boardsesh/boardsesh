import { use } from 'react';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useNativeRootHeader } from './use-native-root-header';

/**
 * The scroll offset at which a root-tab list rests at its top.
 *
 * Under the UIKit header the list sets `contentInsetAdjustmentBehavior` to
 * `automatic`, so iOS insets it by the bar's height and its resting offset is the
 * NEGATIVE of that inset. Offset 0 there is one bar-height down the list: the
 * first row sits behind the header and the controls under it. Everywhere else
 * the list is not inset natively and its top is 0.
 *
 * A list that scrolls itself to this offset also needs `scrollToOverflowEnabled`:
 * React Native clamps a programmatic scroll to the content bounds, which stop at
 * 0 because the inset is UIKit's, not the list's own `contentInset`.
 *
 * Reads the header height from context rather than `useHeaderHeight`, which
 * throws outside a navigator screen: a list must not crash for want of a number
 * it only needs on one platform.
 */
export function useListTopOffset(): number {
  const nativeRootHeader = useNativeRootHeader();
  const headerHeight = use(HeaderHeightContext) ?? 0;
  return nativeRootHeader ? -headerHeight : 0;
}
