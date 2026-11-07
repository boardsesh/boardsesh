import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { MiniPlayerAccessoryBody } from './MiniPlayerAccessoryBody';

/**
 * iOS 26 tab-bar bottom accessory content. UIKit supplies the outer Liquid Glass
 * platter and swaps this subtree between regular and inline placements as the
 * tab bar minimizes, so the content stays bare: {@link MiniPlayerAccessoryBody}
 * at the placement UIKit reports. The Material card renders the same body at
 * `regular`.
 */
export function QueueBottomAccessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  return <MiniPlayerAccessoryBody placement={placement} host="nativeAccessory" />;
}
