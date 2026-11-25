// "Scan a board code": the camera, pushed from the add-a-board wizard's
// "Whose board?" step. It reads one QR code, a friend's board invite, a gym's
// poster, a climb, or a crew session, and opens it the way the system camera
// would have. Anything that is not one of our links gets a gentle "That code
// isn't a Boardsesh board" and the camera keeps looking.
//
// A pushed route, not a sheet: the viewfinder wants the whole screen, and a
// camera inside a pan-to-dismiss sheet fights the drag
// (docs/mobile/mobile-sheets-vs-routes.md).
//
// expo-camera is reached only through camera-module.ts, which answers null on a
// binary built before the camera module shipped. Then this route explains that
// the app needs updating instead of crashing.

import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused, useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { Text } from '../Text';
import { loadBoardCodeCamera, type BoardCodeCamera } from '../../lib/board-code-scanner/camera-module';
import { noteBoardFlowSecured } from '../../lib/boards/board-create-flow';
import { hapticSuccess, hapticWarning } from '../../lib/haptics';
import { openAppSettings } from '../../lib/open-app-settings';
import { parseScannedBoardCode } from '../../lib/routing/scanned-board-code';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

/** Only QR codes: our links are printed and shown as QR, and fewer types scan faster. */
const BARCODE_SETTINGS = { barcodeTypes: ['qr' as const] };

export function BoardCodeScannerScreen() {
  const { t } = useTranslation('boards');
  // The answer cannot change within an app run, so the hooks below stay stable.
  const camera = loadBoardCodeCamera();
  if (!camera) {
    return (
      <EmptyState
        size="screen"
        icon="camera"
        title={t('mobile.scanCode.unavailableTitle')}
        body={t('mobile.scanCode.unavailableBody')}
        testID="board-code-scanner-unavailable"
      />
    );
  }
  return <BoardCodeScanner camera={camera} />;
}

function BoardCodeScanner({ camera }: { camera: BoardCodeCamera }) {
  const { CameraView, useCameraPermissions } = camera;
  const { t } = useTranslation('boards');
  const router = useRouter();
  const isFocused = useIsFocused();
  const { systemColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const [permission, requestPermission] = useCameraPermissions();

  // One code opens one thing. The camera reports the same code many times a
  // second, so a ref (not state) closes the gate before the next frame arrives.
  const handledRef = useRef(false);
  const [handled, setHandled] = useState(false);
  // The last code refused, so holding the camera on it doesn't buzz every frame.
  const lastRefusedRef = useRef<string | null>(null);
  const [refused, setRefused] = useState(false);

  const onBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (handledRef.current || data === lastRefusedRef.current) return;
      const scanned = parseScannedBoardCode(data);
      if (scanned.kind === 'not-boardsesh') {
        lastRefusedRef.current = data;
        setRefused(true);
        hapticWarning();
        return;
      }
      handledRef.current = true;
      setHandled(true);
      hapticSuccess();
      // Replace the boards modal with the link's own route, the one a tapped
      // link opens: the board hand-off or the crew's join screen.
      if (scanned.kind === 'board') {
        noteBoardFlowSecured();
        // A validated app path (scanned-board-code.ts); typed routes can't know that.
        router.replace(scanned.href as Href);
      } else {
        router.replace({ pathname: '/join/[sessionId]', params: { sessionId: scanned.sessionId } });
      }
    },
    [router],
  );

  const onAllow = useCallback(() => void requestPermission(), [requestPermission]);
  const onOpenSettings = useCallback(() => void openAppSettings(), []);

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  if (!permission.granted) {
    return permission.canAskAgain ? (
      <EmptyState
        size="screen"
        icon="camera"
        title={t('mobile.scanCode.permissionTitle')}
        body={t('mobile.scanCode.permissionBody')}
        actions={<Button title={t('mobile.scanCode.allowCamera')} onPress={onAllow} />}
        testID="board-code-scanner-permission"
      />
    ) : (
      <EmptyState
        size="screen"
        icon="camera"
        title={t('mobile.scanCode.deniedTitle')}
        body={t('mobile.scanCode.deniedBody')}
        actions={<Button title={t('mobile.scanCode.openSettings')} onPress={onOpenSettings} />}
        testID="board-code-scanner-denied"
      />
    );
  }

  return (
    <View style={[styles.screen, { paddingBottom: bottomChrome.scrollBottomPadding }]} testID="board-code-scanner">
      <View style={styles.viewfinder}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          mute
          active={isFocused && !handled}
          barcodeScannerSettings={BARCODE_SETTINGS}
          onBarcodeScanned={handled ? undefined : onBarcodeScanned}
          accessibilityLabel={t('mobile.scanCode.viewfinderLabel')}
        />
      </View>
      <View style={styles.caption} accessibilityLiveRegion="polite">
        {refused ? (
          <Text variant="headline" style={styles.captionText}>
            {t('mobile.scanCode.notBoardsesh')}
          </Text>
        ) : null}
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.captionText}>
          {t('mobile.scanCode.hint')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  screen: {
    flex: 1,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    gap: spacing[4],
  },
  viewfinder: {
    flex: 1,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  caption: {
    alignItems: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[2],
  },
  captionText: {
    textAlign: 'center',
  },
});
