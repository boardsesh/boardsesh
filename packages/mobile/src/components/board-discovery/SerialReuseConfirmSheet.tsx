import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';

type SerialReuseConfirmSheetProps = {
  visible: boolean;
  /**
   * The existing board already registered to this serial, or null when the
   * conflicting board is private — the backend masks its identity, so the
   * sheet shows a generic body and only offers "create anyway".
   */
  board: UserBoard | null;
  /** The serial number the user is trying to register. */
  serialNumber: string;
  /** Activate the existing board instead of creating a duplicate. */
  onUseExisting: () => void;
  /** Create a duplicate anyway (backend gets `allowDuplicateSerial: true`). */
  onCreateAnyway: () => void;
  /** Dismiss without deciding. */
  onCancel: () => void;
};

/**
 * Shown before a board is created (and again if the backend's serial guard
 * fires on a race) when the entered serial already belongs to another climber's
 * wall. Steers the user onto that existing board — keeping the crew's sends and
 * stats on one wall — with a de-emphasised "create a duplicate anyway" escape
 * hatch. A plain RN `Modal`, mirroring `BoardDisambiguationSheet`, so it works
 * from the create screen without a bottom-sheet host.
 */
export function SerialReuseConfirmSheet({
  visible,
  board,
  serialNumber,
  onUseExisting,
  onCreateAnyway,
  onCancel,
}: SerialReuseConfirmSheetProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('boards');

  const boardName = board?.name ?? '';
  const location = board?.gymName ?? board?.locationName ?? null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <View style={styles.headingRow}>
            <Icon name="info" size={22} color={iosSystemColors.systemOrange} />
            <Text variant="title3" style={styles.heading}>
              {t('boardForm.serialReuse.dialogTitle')}
            </Text>
          </View>

          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.body}>
            {board
              ? t('boardForm.serialReuse.dialogBody', { serial: serialNumber, name: boardName })
              : t('boardForm.serialReuse.dialogBodyPrivate', { serial: serialNumber })}
          </Text>

          {board ? (
            <View style={[styles.boardRow, { borderColor: systemColors.separator }]}>
              <Text variant="headline">{boardName}</Text>
              {location ? (
                <Text variant="subheadline" color={systemColors.secondaryLabel}>
                  {location}
                </Text>
              ) : null}
              {board.ownerDisplayName ? (
                <Text variant="footnote" color={systemColors.tertiaryLabel}>
                  {board.ownerDisplayName}
                </Text>
              ) : null}
            </View>
          ) : null}

          {board ? (
            <Button
              title={t('boardForm.serialReuse.useExisting')}
              onPress={onUseExisting}
              variant="filled"
              size="large"
              style={styles.primaryAction}
            />
          ) : null}
          <Button title={t('boardForm.serialReuse.createAnyway')} onPress={onCreateAnyway} variant="text" />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  card: {
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    padding: spacing[4],
    paddingBottom: spacing[8],
    maxHeight: '80%',
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginBottom: spacing[2],
  },
  heading: {
    flex: 1,
  },
  body: {
    marginBottom: spacing[4],
  },
  boardRow: {
    gap: spacing[1],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing[4],
  },
  primaryAction: {
    marginBottom: spacing[2],
  },
});
