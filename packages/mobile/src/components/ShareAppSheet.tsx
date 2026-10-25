import { useCallback, useState } from 'react';
import { Platform, Share, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { ModalSheet } from './ModalSheet';
import { Text } from './Text';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';
import { SheetTopBar } from './SheetTopBar';
import { useTheme } from '../providers/theme-provider';
import { useToast } from '../providers/toast-provider';
import { MEDIUM_LARGE_SNAP_POINTS } from './sheet-snap-points';
import { hapticSelection } from '../lib/haptics';
import { storeUrlForAppShare, type StorePlatform } from '../lib/store-links';
import { spacing, borderRadius } from '../theme/tokens';

type ShareAppSheetProps = {
  onDismiss: () => void;
};

const QR_SIZE = 200;
// QR codes need a light background to scan reliably, even in dark mode — the
// scannable surface, not themeable chrome (same as BoardShareSheet).
const QR_TILE_BACKGROUND = '#FFFFFF';

/**
 * Get a friend onto Boardsesh: a store QR they scan with their own camera, plus
 * copy and share for when they're not standing next to you.
 *
 * A QR holds one URL, so the store is a toggle. It opens on the store this phone
 * uses, the likeliest match for a crew member's phone; one tap flips it.
 */
export function ShareAppSheet({ onDismiss }: ShareAppSheetProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const [store, setStore] = useState<StorePlatform>(Platform.OS === 'android' ? 'android' : 'ios');
  const storeUrl = storeUrlForAppShare(store);

  const handleCopyLink = useCallback(() => {
    hapticSelection();
    void Clipboard.setStringAsync(storeUrl).then(() => {
      showToast(t('mobile.about.shareApp.copied'), 'success');
    });
  }, [storeUrl, showToast, t]);

  const handleShare = useCallback(() => {
    hapticSelection();
    // The share message carries both stores: whoever receives it picks theirs.
    void Share.share({
      message: t('mobile.about.shareApp.message', {
        iosUrl: storeUrlForAppShare('ios'),
        androidUrl: storeUrlForAppShare('android'),
      }),
    });
  }, [t]);

  return (
    <ModalSheet
      visible
      onClose={onDismiss}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable
      contentContainerStyle={styles.content}
      header={<SheetTopBar title={t('mobile.about.shareApp.title')} leading={{ kind: 'close', onPress: onDismiss }} />}
    >
      <Text variant="footnote" color={systemColors.label} style={styles.subtitle}>
        {t('mobile.about.shareApp.body')}
      </Text>

      <View style={styles.storeToggle}>
        <SegmentedControl
          options={[
            { key: 'ios', label: t('mobile.about.shareApp.appStore') },
            { key: 'android', label: t('mobile.about.shareApp.googlePlay') },
          ]}
          selectedKey={store}
          onSelect={setStore}
          accessibilityLabel={t('mobile.about.shareApp.storeToggleLabel')}
        />
      </View>

      <View
        style={styles.qrTile}
        accessibilityRole="image"
        accessibilityLabel={
          store === 'android' ? t('mobile.about.shareApp.qrLabelAndroid') : t('mobile.about.shareApp.qrLabelIos')
        }
      >
        <QRCode value={storeUrl} size={QR_SIZE} backgroundColor={QR_TILE_BACKGROUND} />
      </View>

      <View style={styles.actions}>
        <Button
          title={t('mobile.about.shareApp.copyLink')}
          icon="copy"
          variant="outlined"
          onPress={handleCopyLink}
          style={styles.button}
        />
        <Button title={t('mobile.about.shareApp.share')} icon="share" onPress={handleShare} style={styles.button} />
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    paddingBottom: spacing[4],
    gap: spacing[2],
  },
  subtitle: {
    textAlign: 'center',
    lineHeight: 18,
  },
  storeToggle: {
    alignSelf: 'stretch',
    marginTop: spacing[2],
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
    marginTop: spacing[2],
  },
  button: {
    flex: 1,
  },
});
