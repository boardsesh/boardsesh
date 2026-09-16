import { useCallback, useMemo, useRef } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import BottomSheet, { BottomSheetView, type BottomSheetMethods } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius, sheetStyles } from '../../theme/tokens';
import type { SprayWallVisibility } from '../../lib/spray/spray-share';

type BoardShareSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  /** The wall's share URL — already built, and never null (a private wall has none). */
  shareUrl: string;
  wallName: string;
  /**
   * What the link actually grants. A private wall never reaches this sheet, so
   * only the two shareable states are spelled out.
   */
  visibility: Exclude<SprayWallVisibility, 'private'>;
};

const QR_SIZE = 200;
// QR codes need a light background to scan reliably, even in dark mode — this is
// the one place a hardcoded white is correct (it's the scannable surface, not
// themeable chrome).
const QR_TILE_BACKGROUND = '#FFFFFF';

/**
 * Hand a wall's link to the crew — QR to scan at the wall, copy and share for
 * everywhere else.
 *
 * Modelled on `InviteSheet`: same sheet primitives and the same coordinator, so
 * the two never fight over a native transition. The one line of copy under the
 * title is the important part — an unlisted link is a capability and a public
 * wall is on the open web, and those are different promises.
 */
export function BoardShareSheet({ visible, onDismiss, shareUrl, wallName, visibility }: BoardShareSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const windowInsetBottom = useWindowBottomInset();
  const sheetRef = useRef<BottomSheetMethods>(null);

  const managed = useManagedSheet({ open: visible, sheetRef, onClose: onDismiss });

  // A lone '60%' makes @expo/ui's Material sheet skip the partial state and open
  // full-screen on Android; androidSafeSnapPoints adds the full detent.
  const snapPoints = useMemo(() => androidSafeSnapPoints(['60%']), []);

  const handleCopyLink = useCallback(() => {
    hapticSelection();
    void Clipboard.setStringAsync(shareUrl).then(() => {
      showToast(t('mobile.sprayShare.copied'), 'success');
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
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
      backgroundStyle={{ backgroundColor: systemColors.secondaryBackground }}
      handleIndicatorStyle={sheetStyles.indicator}
    >
      <BottomSheetView style={[styles.content, { paddingBottom: windowInsetBottom + spacing[4] }]}>
        <Text variant="title2" style={styles.title}>
          {t('mobile.sprayShare.title')}
        </Text>
        <Text variant="body" color={systemColors.label} style={styles.wallName} numberOfLines={2}>
          {wallName}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.subtitle}>
          {visibility === 'public' ? t('mobile.sprayShare.publicBody') : t('mobile.sprayShare.unlistedBody')}
        </Text>

        <View
          style={styles.qrTile}
          accessibilityRole="image"
          accessibilityLabel={t('mobile.sprayShare.qrLabel', { name: wallName })}
        >
          <QRCode value={shareUrl} size={QR_SIZE} backgroundColor={QR_TILE_BACKGROUND} />
        </View>

        <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={2} style={styles.url}>
          {shareUrl}
        </Text>

        <View style={styles.buttonRow}>
          <Button
            title={t('mobile.sprayShare.copyLink')}
            icon="copy"
            variant="outlined"
            onPress={handleCopyLink}
            style={styles.button}
          />
          <Button title={t('mobile.sprayShare.share')} icon="share" onPress={handleShare} style={styles.button} />
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
    gap: spacing[2],
  },
  title: {
    fontWeight: '600',
    textAlign: 'center',
  },
  wallName: {
    textAlign: 'center',
    fontWeight: '600',
  },
  subtitle: {
    textAlign: 'center',
    lineHeight: 18,
  },
  qrTile: {
    backgroundColor: QR_TILE_BACKGROUND,
    padding: spacing[4],
    borderRadius: borderRadius.lg,
    marginVertical: spacing[2],
  },
  url: {
    textAlign: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing[3],
    width: '100%',
    marginTop: spacing[2],
  },
  button: {
    flex: 1,
  },
});
