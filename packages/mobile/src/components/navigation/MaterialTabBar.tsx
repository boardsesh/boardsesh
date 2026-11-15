import type { BottomTabBarProps } from 'expo-router/tabs';
import { useCallback } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { useAnimatedStyle } from 'react-native-reanimated';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { tabBarHiddenProgress } from '../../lib/tab-bar-hide-progress';
import { useTabBarHidden } from '../../lib/tab-bar-visibility-store';
import { useSetMeasuredTabBarHeight } from '../../providers/tab-bar-height-provider';
import { MATERIAL_TAB_BAR_HEIGHT } from '../../theme/layout';
import { MaterialTabBarView } from './MaterialTabBarView';
export function MaterialTabBar(props: BottomTabBarProps) {
  const setMeasuredTabBarHeight = useSetMeasuredTabBarHeight();
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setMeasuredTabBarHeight(event.nativeEvent.layout.height),
    [setMeasuredTabBarHeight],
  );
  const { jsBarOverlaysContent: overlay } = useBottomChromeMetrics();
  const hidden = useTabBarHidden() && overlay;
  const barHeight = MATERIAL_TAB_BAR_HEIGHT + props.insets.bottom;
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: overlay ? tabBarHiddenProgress.value * barHeight : 0 }],
  }));
  return (
    <MaterialTabBarView {...props} overlay={overlay} hidden={hidden} slideStyle={slideStyle} onLayout={handleLayout} />
  );
}
