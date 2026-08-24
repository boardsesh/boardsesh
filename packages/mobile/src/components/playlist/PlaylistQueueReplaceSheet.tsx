import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type PlaylistQueueReplaceSheetProps = {
  visible: boolean;
  futureQueueCount: number;
  isReplacing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

// Confirmation before a playlist tap replaces the whole queue: replacing clears
// the climbs queued after the current one, so warn first. Built on ModalSheet
// (the shared @expo/ui native sheet wrapper) so it goes through the presentation
// coordinator and never overlaps another native sheet.
//
// Cancel stays live while the replacement is in flight, and so does pan-to-close.
// Confirming here genuinely starts the page drain, and a throttled first page can
// now back off for the length of a server window (#4622) — locking the climber
// into a modal for that long would read as a hung app. `onCancel` aborts the
// in-flight drain and its sleep, so leaving is instant. Only Confirm is blocked
// while replacing (it shows a spinner), so a double-tap can't start two drains.
export function PlaylistQueueReplaceSheet({
  visible,
  futureQueueCount,
  isReplacing,
  onCancel,
  onConfirm,
}: PlaylistQueueReplaceSheetProps) {
  const { t } = useTranslation('playlists');
  const { systemColors } = useTheme();

  return (
    <ModalSheet visible={visible} enableDynamicSizing onClose={onCancel}>
      {/* The footerless ModalSheet wrapper composes insets.bottom onto the body
          (withSheetBottomInset), so this content only adds its own spacing. */}
      <View style={styles.content}>
        <Icon name="queue" size={40} color={systemColors.secondaryLabel} />

        <Text variant="title2" style={styles.title}>
          {t('detail.queueReplace.title')}
        </Text>

        <Text variant="body" color={systemColors.secondaryLabel} style={styles.subtitle}>
          {t('detail.queueReplace.message', { count: futureQueueCount })}
        </Text>

        <View style={styles.buttonRow}>
          <Button
            title={t('detail.queueReplace.cancel')}
            variant="outlined"
            role="cancel"
            onPress={onCancel}
            style={styles.button}
          />
          <Button
            title={t('detail.queueReplace.confirm')}
            onPress={onConfirm}
            loading={isReplacing}
            style={styles.button}
          />
        </View>
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    paddingBottom: spacing[3],
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
  buttonRow: {
    flexDirection: 'row',
    gap: spacing[3],
    marginTop: spacing[4],
    width: '100%',
  },
  button: {
    flex: 1,
  },
});
