import { useSheetColumnStyle } from '../use-sheet-column-style';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
// SPIKE(spike/expo-bottom-sheet): swap gorhom -> Expo's native drop-in. The native
// sheet renders its own scrim, so the custom SheetBackdrop wiring is dropped.
import BottomSheet, {
  BottomSheetView,
  BottomSheetScrollView,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useShowcaseAnchor } from '../../lib/showcase-anchor';
import { Text } from '../Text';
import { Button } from '../Button';
import { SheetTopBar } from '../SheetTopBar';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { androidSafeSnapPoints, MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius, sheetStyles } from '../../theme/tokens';
import { buildSessionShareUrl } from '../../lib/session-share';

type InviteSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  sessionId: string;
};

const QR_SIZE = 200;
// QR codes need a light background to scan reliably, even in dark mode — this is
// the one place a hardcoded white is correct (it's the scannable surface, not
// themeable chrome).
const QR_TILE_BACKGROUND = '#FFFFFF';

export function InviteSheet({ visible, onDismiss, sessionId }: InviteSheetProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const windowInsetBottom = useWindowBottomInset();
  const sheetRef = useRef<BottomSheetMethods>(null);
  const qrAnchor = useShowcaseAnchor('invite-qr');

  const shareUrl = useMemo(() => buildSessionShareUrl(sessionId), [sessionId]);

  // Present/dismiss route through the coordinator (serialized, no overlapping
  // native transitions). Always mounted by SessionScreen and toggled via
  // `visible`, so no onFullyDismissed; `onDismiss` clears the parent's open state
  // on a user pan-down / backdrop.
  const managed = useManagedSheet({ open: visible, sheetRef, onClose: onDismiss });

  const [activeIndex, setActiveIndex] = useState(0);
  // Standard medium/large keeps the QR code scrollable on small phones.
  const snapPoints = useMemo(() => androidSafeSnapPoints(MEDIUM_LARGE_SNAP_POINTS), []);
  const columnStyle = useSheetColumnStyle(snapPoints, { activeIndex });

  const handleCopyLink = useCallback(() => {
    hapticSelection();
    void Clipboard.setStringAsync(shareUrl).then(() => {
      showToast(t('mobile.session.inviteCopied'), 'success');
    });
  }, [shareUrl, showToast, t]);

  const handleShare = useCallback(() => {
    hapticSelection();
    void Share.share({ message: shareUrl, url: shareUrl });
  }, [shareUrl]);

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={(index) => {
        managed.onChange(index);
        setActiveIndex(Math.max(0, index));
      }}
      onFullyDismissed={managed.onFullyDismissed}
      backgroundStyle={{ backgroundColor: systemColors.secondaryBackground }}
      handleIndicatorStyle={sheetStyles.indicator}
    >
      {/* The sheet's single child: the top bar and the body share it. */}
      <BottomSheetView style={[styles.column, columnStyle, { paddingBottom: windowInsetBottom + spacing[4] }]}>
        <SheetTopBar title={t('mobile.session.inviteTitle')} leading={{ kind: 'close', onPress: onDismiss }} />
        <BottomSheetScrollView contentContainerStyle={styles.content}>
          <Text variant="body" color={systemColors.secondaryLabel} style={styles.subtitle}>
            {t('mobile.session.inviteSubtitle')}
          </Text>

          <View style={styles.qrTile} {...qrAnchor}>
            <QRCode value={shareUrl} size={QR_SIZE} backgroundColor={QR_TILE_BACKGROUND} />
          </View>

          {/* Content actions, not a form confirm: they stay in the body, one
              full-width row (stacked they would overflow the medium detent). */}
          <View style={styles.actions}>
            <Button
              title={t('mobile.session.inviteCopyLink')}
              icon="copy"
              variant="outlined"
              onPress={handleCopyLink}
              style={styles.button}
            />
            <Button title={t('mobile.session.inviteShare')} icon="share" onPress={handleShare} style={styles.button} />
          </View>
        </BottomSheetScrollView>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  column: {
    flex: 1,
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    gap: spacing[3],
  },
  subtitle: {
    textAlign: 'center',
    lineHeight: 20,
  },
  qrTile: {
    backgroundColor: QR_TILE_BACKGROUND,
    padding: spacing[4],
    borderRadius: borderRadius.lg,
    marginVertical: spacing[2],
  },
  actions: {
    flexDirection: 'row',
    gap: spacing[3],
    alignSelf: 'stretch',
  },
  button: {
    flex: 1,
  },
});
