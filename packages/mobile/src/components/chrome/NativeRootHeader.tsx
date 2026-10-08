import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Stack, useSegments } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useTranslation } from 'react-i18next';
import { tabsActiveSegment } from '../../lib/route-segments';
import { useTheme } from '../../providers/theme-provider';
import { useGlassCapability } from '../../hooks/use-glass-capability';
import { glassSize } from '../../theme/layout';

import { NativeHeaderActionContext, NativeHeaderOwnBackgroundContext } from './native-header-action-context';

/** UIKit owns title collapse, edge effects, Dynamic Type and the status-bar tap. */
export function NativeRootHeader({
  title,
  leftActions,
  leftActionsStandalone = false,
  rightActions,
  centerContent,
  children,
  onHeightChange,
}: {
  title?: string;
  leftActions?: ReactNode;
  /** A single avatar draws a circle instead of UIKit's wider shared capsule. */
  leftActionsStandalone?: boolean;
  rightActions?: ReactNode;
  /** Interactive content in the compact native bar, beside the action groups. */
  centerContent?: ReactNode;
  children?: ReactNode;
  onHeightChange: (height: number) => void;
}) {
  const { t } = useTranslation('common');
  const { t: tSession } = useTranslation('session');
  const { t: tPlaylists } = useTranslation('playlists');
  const segments = useSegments();
  const { systemColors } = useTheme();
  const glassCapability = useGlassCapability();
  const headerHeight = useHeaderHeight();
  const controlsHeight = useRef(0);
  const titleByTab: Record<string, string> = {
    home: t('mobile.nav.home'),
    climbs: t('mobile.nav.climbs'),
    record: tSession('mobile.session.recordTab'),
    discover: tPlaylists('bottomTabBar.discover'),
    profile: t('mobile.nav.profile'),
    wall: t('mobile.nav.wall'),
  };
  const hasControls = children != null;
  useLayoutEffect(() => {
    if (!hasControls) controlsHeight.current = 0;
    onHeightChange(controlsHeight.current);
  }, [onHeightChange, hasControls]);
  const measureControls = useCallback(
    (event: LayoutChangeEvent) => {
      controlsHeight.current = event.nativeEvent.layout.height;
      onHeightChange(controlsHeight.current);
    },
    [onHeightChange],
  );
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerLargeTitle: true,
          headerTransparent: true,
          // iOS 26 owns the scroll-edge material; don't inherit the legacy blur.
          headerBlurEffect: glassCapability ? undefined : 'systemMaterial',
          headerShadowVisible: false,
          headerLargeTitleShadowVisible: false,
          title: title ?? titleByTab[tabsActiveSegment(segments) ?? ''] ?? '',
          headerTitle:
            centerContent != null
              ? () => (
                  <NativeHeaderActionContext.Provider value={true}>
                    <View pointerEvents="box-none" style={styles.centerContent}>
                      {centerContent}
                    </View>
                  </NativeHeaderActionContext.Provider>
                )
              : undefined,
          headerTitleStyle: { color: systemColors.label },
          headerLargeTitleStyle: { color: systemColors.label },
          headerLeft:
            leftActions && !leftActionsStandalone
              ? () => (
                  <NativeHeaderActionContext.Provider value={true}>{leftActions}</NativeHeaderActionContext.Provider>
                )
              : undefined,
          unstable_headerLeftItems:
            leftActions && leftActionsStandalone
              ? () => [
                  {
                    type: 'custom',
                    hidesSharedBackground: true,
                    element: (
                      <NativeHeaderActionContext.Provider value={true}>
                        <NativeHeaderOwnBackgroundContext.Provider value={true}>
                          {leftActions}
                        </NativeHeaderOwnBackgroundContext.Provider>
                      </NativeHeaderActionContext.Provider>
                    ),
                  },
                ]
              : undefined,
          headerRight: rightActions
            ? () => <NativeHeaderActionContext.Provider value={true}>{rightActions}</NativeHeaderActionContext.Provider>
            : undefined,
        }}
      />
      {hasControls ? (
        <View
          onLayout={measureControls}
          style={[styles.controls, { top: headerHeight, backgroundColor: systemColors.background }]}
        >
          {children}
        </View>
      ) : null}
    </>
  );
}
const styles = StyleSheet.create({
  controls: { position: 'absolute', left: 0, right: 0, zIndex: 20 },
  centerContent: {
    height: glassSize.inline,
    maxWidth: '100%',
    minWidth: 0,
    flexShrink: 1,
    alignItems: 'stretch',
    justifyContent: 'center',
  },
});
