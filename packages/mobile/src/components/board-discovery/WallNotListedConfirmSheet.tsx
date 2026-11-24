// "My board isn't listed" on a gym's wall list (#8151): asked before the
// builder opens, so a second copy of a wall the crew already climbs on is a
// choice, not an accident. Modelled on BoardDuplicatePromptSheet: dismissing
// it means "keep looking" and nothing else.
//
// Two bodies. With walls listed, it asks whether theirs is a separate one.
// When the lookup failed, it says the check couldn't run and offers to add
// theirs anyway; the server still runs its own check on save.

import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { MEDIUM_SNAP_POINTS } from '../sheet-snap-points';

type WallNotListedConfirmSheetProps = {
  gymName: string;
  /** Walls the climber was shown. Ignored when `lookupFailed`. */
  candidateCount: number;
  /** The wall lookup failed: the sheet says so instead of counting walls. */
  lookupFailed: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
};

export function WallNotListedConfirmSheet({
  gymName,
  candidateCount,
  lookupFailed,
  onConfirm,
  onDismiss,
}: WallNotListedConfirmSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const handleConfirm = useCallback(() => onConfirm(), [onConfirm]);

  return (
    <ModalSheet
      visible
      snapPoints={MEDIUM_SNAP_POINTS}
      enablePanDownToClose
      onClose={onDismiss}
      header={
        <SheetTopBar
          title={t('mobile.findWall.confirmTitle', { gym: gymName })}
          leading={{
            kind: 'close',
            onPress: onDismiss,
            accessibilityLabel: t('mobile.findWall.confirmKeepLooking'),
          }}
        />
      }
    >
      <View style={styles.content}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
          {lookupFailed
            ? t('mobile.findWall.confirmBodyLookupFailed', { gym: gymName })
            : t('mobile.findWall.confirmBody', { count: candidateCount })}
        </Text>
        <Button
          title={lookupFailed ? t('mobile.findWall.addAnyway') : t('mobile.findWall.confirmDifferent')}
          onPress={handleConfirm}
          size="medium"
          style={styles.fullWidth}
          testID="wall-not-listed-confirm"
        />
        <Button
          title={t('mobile.findWall.confirmKeepLooking')}
          onPress={onDismiss}
          variant="tonal"
          size="medium"
          style={styles.fullWidth}
        />
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    gap: spacing[3],
  },
  centered: {
    textAlign: 'center',
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
});
