import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Share, StyleSheet, View } from 'react-native';
// SPIKE(spike/expo-bottom-sheet): swap gorhom -> Expo's native drop-in. The native
// sheet renders its own scrim, so the custom SheetBackdrop wiring is dropped.
import BottomSheet, { BottomSheetView, type BottomSheetMethods } from '@expo/ui/community/bottom-sheet';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useShowcaseAnchor } from '../../lib/showcase-anchor';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius, sheetStyles } from '../../theme/tokens';
import { buildSessionShareUrl } from '../../lib/session-share';
import {
  trackSessionInviteLinkCopied,
  trackSessionInviteSheetOpened,
  trackSessionInviteSystemShare,
} from '../../lib/session-invite-analytics';

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

  // Route the single detent through androidSafeSnapPoints: a lone '60%' would make
  // @expo/ui's Material sheet skip the partial state and open full-screen; this
  // adds a full detent so Android opens partial (draggable to full). iOS keeps 60%.
  const snapPoints = useMemo(() => androidSafeSnapPoints(['60%']), []);

  // The sheet is always mounted and toggled through `visible`, so "opened" is
  // the false -> true edge, once per open. Showing the QR is part of opening:
  // the code is on screen the moment the sheet is, and a scan leaves no trace
  // on this phone, so there is no separate QR event to fire.
  useEffect(() => {
    if (visible && sessionId) trackSessionInviteSheetOpened(sessionId);
  }, [visible, sessionId]);

  const handleCopyLink = useCallback(() => {
    hapticSelection();
    void Clipboard.setStringAsync(shareUrl).then(() => {
      showToast(t('mobile.session.inviteCopied'), 'success');
      trackSessionInviteLinkCopied(sessionId);
    });
  }, [sessionId, shareUrl, showToast, t]);

  const handleShare = useCallback(() => {
    hapticSelection();
    void Share.share({ message: shareUrl, url: shareUrl })
      .then((result) => trackSessionInviteSystemShare(sessionId, result))
      // A rejected share is the platform refusing to open the sheet; there is
      // nothing to count and nothing the climber can do about it here.
      .catch(() => {});
  }, [sessionId, shareUrl]);

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
      backgroundStyle={{ backgroundColor: systemColors.secondaryBackground }}
      handleIndicatorStyle={sheetStyles.indicator}
    >
      <BottomSheetView style={[styles.content, { paddingBottom: windowInsetBottom + spacing[4] }]}>
        <Text variant="title2" style={styles.title}>
          {t('mobile.session.inviteTitle')}
        </Text>
        <Text variant="body" color={systemColors.secondaryLabel} style={styles.subtitle}>
          {t('mobile.session.inviteSubtitle')}
        </Text>

        <View style={styles.qrTile} {...qrAnchor}>
          <QRCode value={shareUrl} size={QR_SIZE} backgroundColor={QR_TILE_BACKGROUND} />
        </View>

        <View style={styles.buttonRow}>
          <Button
            title={t('mobile.session.inviteCopyLink')}
            icon="copy"
            variant="outlined"
            onPress={handleCopyLink}
            style={styles.button}
          />
          <Button title={t('mobile.session.inviteShare')} icon="share" onPress={handleShare} style={styles.button} />
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    gap: spacing[3],
  },
  title: {
    fontWeight: '600',
    textAlign: 'center',
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
  buttonRow: {
    flexDirection: 'row',
    gap: spacing[3],
    width: '100%',
  },
  button: {
    flex: 1,
  },
});
