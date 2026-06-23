import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import BottomSheet, { BottomSheetView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { SheetBackdrop } from '../SheetBackdrop';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
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
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheet>(null);
  const [mounted, setMounted] = useState(false);

  const shareUrl = useMemo(() => buildSessionShareUrl(sessionId), [sessionId]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
    }
  }, [visible]);

  useEffect(() => {
    if (mounted) {
      sheetRef.current?.expand();
    }
  }, [mounted]);

  const snapPoints = useMemo(() => ['60%'], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />,
    [],
  );

  const handleClose = useCallback(() => {
    setMounted(false);
    onDismiss();
  }, [onDismiss]);

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

  if (!mounted) return null;

  return (
    <BottomSheet
      ref={sheetRef}
      snapPoints={snapPoints}
      enablePanDownToClose
      onClose={handleClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: systemColors.secondaryBackground }}
      handleIndicatorStyle={sheetStyles.indicator}
    >
      <BottomSheetView style={[styles.content, { paddingBottom: insets.bottom + spacing[4] }]}>
        <Text variant="title2" style={styles.title}>
          {t('mobile.session.inviteTitle')}
        </Text>
        <Text variant="body" color={systemColors.secondaryLabel} style={styles.subtitle}>
          {t('mobile.session.inviteSubtitle')}
        </Text>

        <View style={styles.qrTile}>
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
