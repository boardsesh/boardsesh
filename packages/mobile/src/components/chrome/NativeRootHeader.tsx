import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Stack, useSegments } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useTranslation } from 'react-i18next';
import { tabsActiveSegment } from '../../lib/route-segments';
import { useTheme } from '../../providers/theme-provider';

import { NativeHeaderActionContext } from './native-header-action-context';

/** UIKit owns title collapse, edge effects, Dynamic Type and the status-bar tap. */
export function NativeRootHeader({
  title,
  leftActions,
  rightActions,
  children,
  onHeightChange,
}: {
  title?: string;
  leftActions?: ReactNode;
  rightActions?: ReactNode;
  children?: ReactNode;
  onHeightChange: (height: number) => void;
}) {
  const { t } = useTranslation('common');
  const { t: tSession } = useTranslation('session');
  const { t: tPlaylists } = useTranslation('playlists');
  const segments = useSegments();
  const { systemColors } = useTheme();
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
  useLayoutEffect(() => onHeightChange(controlsHeight.current), [onHeightChange]);
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
          headerShadowVisible: false,
          headerLargeTitleShadowVisible: false,
          title: title ?? titleByTab[tabsActiveSegment(segments) ?? ''] ?? '',
          headerLeft: leftActions
            ? () => <NativeHeaderActionContext.Provider value={true}>{leftActions}</NativeHeaderActionContext.Provider>
            : undefined,
          headerRight: rightActions
            ? () => <NativeHeaderActionContext.Provider value={true}>{rightActions}</NativeHeaderActionContext.Provider>
            : undefined,
        }}
      />
      {children ? (
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
const styles = StyleSheet.create({ controls: { position: 'absolute', left: 0, right: 0, zIndex: 20 } });
