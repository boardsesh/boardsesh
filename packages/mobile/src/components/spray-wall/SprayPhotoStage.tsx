import { useEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import { useTheme } from '../../providers/theme-provider';
import {
  createSprayPhotoSession,
  updateSprayPhotoSession,
  closeSprayPhotoSession,
} from '../../lib/spray/spray-photo-session';
import { SprayPhotoCanvas, type SprayPhotoCanvasProps } from './SprayPhotoCanvas';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
/** Default wall-photo surface for setup editors: full host width, pinch/pan and fullscreen. */
export function SprayPhotoStage({
  width,
  tools,
  fullScreenRail,
  overlayTools,
  accessoryTools,
  canvas,
}: {
  width: number;
  tools: ReactNode;
  fullScreenRail?: ReactNode;
  overlayTools?: ReactNode;
  accessoryTools?: ReactNode;
  canvas: Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'>;
}) {
  const router = useRouter(),
    viewerId = useViewerUserId();
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const session = useRef<string | null>(null);
  const owner = useRef<{ viewerId: string; photoKey: string } | null>(null);
  const photoKey = JSON.stringify([canvas.source.layoutId, canvas.source.versionId, canvas.photoUri]);
  useEffect(() => {
    if (session.current && (owner.current?.viewerId !== viewerId || owner.current?.photoKey !== photoKey)) {
      closeSprayPhotoSession(session.current);
      return;
    }
    if (session.current && viewerId)
      updateSprayPhotoSession(session.current, {
        viewerId,
        canvas,
        tools,
        fullScreenRail,
        overlayTools,
        accessoryTools,
      });
  }, [viewerId, canvas, tools, fullScreenRail, overlayTools, accessoryTools, photoKey]);
  useEffect(
    () => () => {
      if (session.current) closeSprayPhotoSession(session.current);
    },
    [],
  );
  return (
    <View style={{ width, alignSelf: 'center' }}>
      <SprayPhotoCanvas
        {...canvas}
        maxWidth={width}
        maxHeight={(width * canvas.source.frame.height) / canvas.source.frame.width}
      />
      <View style={styles.overlay}>
        <PressableSurface
          accessibilityRole="button"
          accessibilityLabel={t('sprayLedSetup.fullScreen')}
          style={[styles.expand, { backgroundColor: systemColors.secondaryGroupedBackground }]}
          onPress={() => {
            if (!viewerId || session.current) return;
            const photoSessionId = createSprayPhotoSession(
              { viewerId, canvas, tools, fullScreenRail, overlayTools, accessoryTools },
              () => {
                session.current = null;
              },
            );
            owner.current = { viewerId, photoKey };
            session.current = photoSessionId;
            router.push({ pathname: '/spray-led-fullscreen', params: { photoSessionId } });
          }}
        >
          <Icon name="expand" size={22} color={systemColors.label} />
        </PressableSurface>
        {overlayTools}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 8,
    right: 8,
    gap: 8,
    alignItems: 'center',
  },
  expand: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
