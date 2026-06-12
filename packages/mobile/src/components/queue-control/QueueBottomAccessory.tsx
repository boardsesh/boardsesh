import { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useQueue } from '../../providers/queue-provider';
import { useReportNativeAccessoryPlacement } from '../../hooks/use-bottom-accessory';
import {
  glassSize,
  NATIVE_BOTTOM_ACCESSORY_MAX_WIDTH,
  NATIVE_BOTTOM_ACCESSORY_SCREEN_GUTTER,
} from '../../theme/layout';
import { NativeAccessoryClimbRow } from './NativeAccessoryClimbRow';
import { useWallOrQueueCurrentClimb } from './use-wall-or-queue-climb';

/**
 * iOS 26 tab-bar bottom accessory content. UIKit supplies the outer Liquid Glass
 * platter and swaps this subtree between regular and inline placements as the
 * tab bar minimizes, so the content stays bare: current climb plus tick only.
 */
export function QueueBottomAccessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  useReportNativeAccessoryPlacement(placement);
  const { width: screenWidth } = useWindowDimensions();
  const { state } = useQueue();
  // Show the accessory when there's a local queue climb OR a live wall climb
  // (the flag-gated source flip — see useWallOrQueueCurrentClimb). The row itself
  // re-applies the same selector for what it renders + ticks.
  const currentClimb = useWallOrQueueCurrentClimb(state.currentClimbQueueItem?.climb ?? null);

  const accessoryWidth = useMemo(() => {
    return Math.max(
      glassSize.standard * 2,
      Math.min(NATIVE_BOTTOM_ACCESSORY_MAX_WIDTH, screenWidth - NATIVE_BOTTOM_ACCESSORY_SCREEN_GUTTER),
    );
  }, [screenWidth]);

  if (!currentClimb) return null;

  return (
    <View
      style={[styles.row, placement === 'inline' ? styles.inlineRow : styles.regularRow, { width: accessoryWidth }]}
    >
      <NativeAccessoryClimbRow placement={placement} width={accessoryWidth} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  regularRow: {
    height: glassSize.standard,
  },
  inlineRow: {
    height: glassSize.inline,
  },
});
