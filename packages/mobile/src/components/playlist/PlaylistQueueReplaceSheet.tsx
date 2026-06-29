import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
// coordinator and never overlaps another native sheet. Pan-to-close is locked
// while the replacement is in flight; the buttons drive the decision.
export function PlaylistQueueReplaceSheet({
  visible,
  futureQueueCount,
  isReplacing,
  onCancel,
  onConfirm,
}: PlaylistQueueReplaceSheetProps) {
  const { t } = useTranslation('playlists');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <ModalSheet visible={visible} enableDynamicSizing enablePanDownToClose={!isReplacing} onClose={onCancel}>
      <View style={[styles.content, { paddingBottom: insets.bottom + spacing[3] }]}>
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
            disabled={isReplacing}
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
