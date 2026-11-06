import { useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View, ScrollView } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { isValidTnutGrid } from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../src/providers/theme-provider';
import { useAuth } from '../src/providers/auth-provider';
import { useViewerUserId } from '../src/hooks/use-viewer-user-id';
import { PressableSurface } from '../src/components/PressableSurface';
import { Icon } from '../src/components/Icon';
import { SprayCornerMarker } from '../src/components/spray-wall/SprayCornerMarker';
import { FlattenedSprayPhoto } from '../src/components/spray-wall/FlattenedSprayPhoto';
import { SprayPhotoCanvas } from '../src/components/spray-wall/SprayPhotoCanvas';
import { shouldUseSprayPhotoRail } from '../src/components/spray-wall/spray-fullscreen-layout';
import {
  closeSprayPhotoSession,
  readSprayPhotoSession,
  subscribeSprayPhotoSession,
} from '../src/lib/spray/spray-photo-session';
import { holdUntilLaunchReady } from '../src/components/launch-update/hold-until-launch-ready';
import { useSprayWizardLeaveGuard } from '../src/components/spray-wall/use-spray-wizard-leave-guard';
import {
  closeTnutCalibrationSession,
  readTnutCalibrationSession,
  subscribeTnutCalibrationSession,
  updateTnutCalibrationSession,
} from '../src/lib/spray/tnut-calibration-session';

/** Utility route: only a live, authenticated editor can supply its private photo. */
function SprayLedFullscreen() {
  const { sessionId, photoSessionId } = useLocalSearchParams<{
    sessionId?: string | string[];
    photoSessionId?: string | string[];
  }>();
  const photoId = typeof photoSessionId === 'string' ? photoSessionId : '';
  const photoSnapshot = useSyncExternalStore(
    subscribeSprayPhotoSession,
    () => readSprayPhotoSession(photoId),
    () => null,
  );
  const id = typeof sessionId === 'string' ? sessionId : '';
  const snapshot = useSyncExternalStore(
    subscribeTnutCalibrationSession,
    () => readTnutCalibrationSession(id),
    () => null,
  );
  const { isAuthenticated } = useAuth();
  const viewerId = useViewerUserId();
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { systemColors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [toolsHeight, setToolsHeight] = useState(0);
  const [accessoryHeight, setAccessoryHeight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const closing = useRef(false);
  useSprayWizardLeaveGuard((leave) => {
    closing.current = true;
    closeTnutCalibrationSession(id);
    closeSprayPhotoSession(photoId);
    leave();
  });
  if (closing.current) return null;
  if ((!snapshot && !photoSnapshot) || !isAuthenticated || viewerId !== (photoSnapshot ?? snapshot)?.viewerId)
    return <Redirect href="/boards" />;
  const closeButton = (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={t('sprayLedSetup.closeFullScreen')}
      disabled={dragging}
      onPress={() => router.back()}
      style={[styles.close, { backgroundColor: systemColors.secondaryGroupedBackground }]}
    >
      <Icon name="fit.screen" size={22} color={systemColors.label} />
    </PressableSurface>
  );
  if (photoSnapshot) {
    const { frame } = photoSnapshot.canvas.source;
    const rail =
      Boolean(photoSnapshot.fullScreenRail) &&
      shouldUseSprayPhotoRail(available.width, available.height, frame.width, frame.height);
    return (
      <View
        testID="spray-fullscreen-layout"
        style={{
          flex: 1,
          backgroundColor: systemColors.background,
          paddingLeft: insets.left,
          paddingRight: insets.right,
          paddingBottom: insets.bottom,
          paddingTop: insets.top,
        }}
        onLayout={({ nativeEvent }) => setAvailable(nativeEvent.layout)}
      >
        <View
          testID="spray-fullscreen-canvas"
          style={styles.canvas}
          onLayout={({ nativeEvent }) => setBox(nativeEvent.layout)}
        >
          <SprayPhotoCanvas
            {...photoSnapshot.canvas}
            maxWidth={box.width}
            maxHeight={box.height}
            onInteractionChange={setDragging}
          />
        </View>
        {!rail && (
          <ScrollView
            testID="spray-fullscreen-bottom-tools"
            style={{
              height: Math.min(toolsHeight, available.height * 0.35),
              flexGrow: 0,
              paddingHorizontal: spacing[4],
            }}
            onContentSizeChange={(_width, height) => setToolsHeight(height)}
            scrollEnabled={!dragging}
          >
            {photoSnapshot.tools}
          </ScrollView>
        )}
        {photoSnapshot.accessoryTools && (
          <ScrollView
            style={{
              height: Math.min(accessoryHeight, available.height * 0.25),
              flexGrow: 0,
              paddingHorizontal: spacing[4],
            }}
            onContentSizeChange={(_width, height) => setAccessoryHeight(height)}
            scrollEnabled={!dragging}
          >
            {photoSnapshot.accessoryTools}
          </ScrollView>
        )}
        <View
          style={[
            styles.overlay,
            {
              top: insets.top + spacing[2],
              right: insets.right + spacing[2],
              maxHeight: Math.max(0, available.height - insets.top - insets.bottom - 16),
            },
          ]}
        >
          {closeButton}
          {photoSnapshot.overlayTools}
          {rail && (
            <ScrollView
              testID="spray-fullscreen-rail"
              style={{ flexGrow: 0 }}
              scrollEnabled={!dragging}
              contentContainerStyle={{ gap: 8, alignItems: 'center' }}
            >
              {photoSnapshot.fullScreenRail}
            </ScrollView>
          )}
        </View>
      </View>
    );
  }
  if (!snapshot) return null;
  const { source, photoUri, quad, grid } = snapshot;
  const corners = {
    topLeft: { x: quad[0][0] / source.frame.width, y: quad[0][1] / source.frame.height },
    topRight: { x: quad[1][0] / source.frame.width, y: quad[1][1] / source.frame.height },
    bottomRight: { x: quad[2][0] / source.frame.width, y: quad[2][1] / source.frame.height },
    bottomLeft: { x: quad[3][0] / source.frame.width, y: quad[3][1] / source.frame.height },
  };
  return (
    <View
      style={[styles.canvas, { backgroundColor: systemColors.background }]}
      onLayout={({ nativeEvent }) => setBox(nativeEvent.layout)}
    >
      <SprayCornerMarker
        photo={{ uri: photoUri, width: source.frame.width, height: source.frame.height }}
        value={quad}
        maxWidth={box.width}
        maxHeight={box.height}
        enableZoom
        edgeToEdge
        tnutGrid={grid}
        invalid={!isValidTnutGrid({ ...grid, corners })}
        renderBackdrop={(width, height) => (
          <FlattenedSprayPhoto source={source} photoUri={photoUri} tile={{ width, height }} />
        )}
        onDragActiveChange={setDragging}
        onChange={(nextQuad) => updateTnutCalibrationSession(id, nextQuad)}
      />
      <PressableSurface
        accessibilityRole="button"
        accessibilityLabel={t('sprayLedSetup.closeFullScreen')}
        disabled={dragging}
        onPress={() => router.back()}
        style={[
          styles.close,
          { position: 'absolute' },
          {
            top: insets.top + spacing[2],
            right: insets.right + spacing[2],
            backgroundColor: systemColors.secondaryGroupedBackground,
          },
        ]}
      >
        <Icon name="fit.screen" size={22} color={systemColors.label} />
      </PressableSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: { position: 'absolute', gap: 8, alignItems: 'center' },
});

export default holdUntilLaunchReady(SprayLedFullscreen);
