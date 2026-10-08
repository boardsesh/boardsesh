import { useCallback, useMemo } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { ModalSheet } from '../ModalSheet';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useShowcaseAnchor } from '../../lib/showcase-anchor';
import { Text } from '../Text';
import { Button } from '../Button';
import { SheetTopBar } from '../SheetTopBar';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
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
  const qrAnchor = useShowcaseAnchor('invite-qr');

  const shareUrl = useMemo(() => buildSessionShareUrl(sessionId), [sessionId]);

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
    <ModalSheet
      visible={visible}
      onClose={onDismiss}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable
      contentContainerStyle={styles.content}
      header={<SheetTopBar title={t('mobile.session.inviteTitle')} leading={{ kind: 'close', onPress: onDismiss }} />}
    >
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
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    paddingBottom: spacing[4],
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
