import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNativeTabBar } from '../../hooks/use-bottom-accessory';
import { publishNativeTabContentInsetBottom } from '../../lib/native-tab-content-inset-store';

/**
 * Publishes the bottom safe-area inset measured INSIDE a native tab's content to
 * `native-tab-content-inset-store`. Mount one as a sibling of the `Stack` in each
 * phone tab layout — there it sits inside the nested `SafeAreaProvider` that
 * expo-router's `NativeTabsView` wraps around every tab's content, so the inset
 * it reads includes the UIKit tab bar, the BottomAccessory, and the live
 * minimize state (unlike the root provider, which only sees the home indicator).
 *
 * Renders nothing, publishes nothing off the native-tab-bar path (Material,
 * tablets, Android, iOS < 26 — `useNativeTabBar()` is the same predicate that
 * selects the tab bar in `(tabs)/_layout`, so the two cannot disagree).
 */
export function NativeTabContentInsetProbe() {
  const nativeTabBar = useNativeTabBar();
  if (!nativeTabBar) return null;
  return <NativeTabContentInsetPublisher />;
}

function NativeTabContentInsetPublisher() {
  const insets = useSafeAreaInsets();
  // Focus-gated: expo-router renders EVERY tab's screen (no freeze), each inside
  // its own nested SafeAreaProvider, and an unfocused tab's detached native view
  // can report a bar-less inset. With five publishers racing a last-writer-wins
  // store, one stale unfocused write would put the Start capsule right back under
  // the tab bar — only the focused tab's surface is the truth worth publishing.
  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );

  useEffect(() => {
    if (!isFocused) return;
    publishNativeTabContentInsetBottom(insets.bottom);
  }, [isFocused, insets.bottom]);

  return null;
}
