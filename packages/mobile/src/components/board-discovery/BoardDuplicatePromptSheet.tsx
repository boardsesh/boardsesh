// Shown when createBoard reports the user already owns a board with this
// configuration at this place. Replaces the silent auto-activate that caused
// #4166, where a climber's new-gym board was thrown away and their OLD board was
// quietly made active instead — with no message either way.
//
// Three outcomes, all explicit. Deliberately not `useConfirm()`: a two-button
// confirm has to map a scrim/back dismissal onto one of the real choices, and
// choosing silently on the user's behalf is the exact bug being fixed here.
// Dismissing this sheet means "keep editing" and nothing else.

import { useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { DuplicateBoardError } from '../../lib/graphql/extract-error-message';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { MEDIUM_SNAP_POINTS } from '../sheet-snap-points';

const SNAP_POINTS = MEDIUM_SNAP_POINTS;

type BoardDuplicatePromptSheetProps = {
  duplicate: DuplicateBoardError;
  /** True while "use that board" is resolving the existing board. */
  busy?: boolean;
  onUseExisting: () => void;
  onAddAnother: () => void;
  onDismiss: () => void;
};

export function BoardDuplicatePromptSheet({
  duplicate,
  busy = false,
  onUseExisting,
  onAddAnother,
  onDismiss,
}: BoardDuplicatePromptSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  // Presence-driven: the host mounts this only while a duplicate is pending, so
  // `visible` is constant true and the coordinator handles present/dismiss.

  const handleUseExisting = useCallback(() => {
    if (busy) return;
    onUseExisting();
  }, [busy, onUseExisting]);

  const handleAddAnother = useCallback(() => {
    if (busy) return;
    onAddAnother();
  }, [busy, onAddAnother]);

  // Inert while busy: cancelling mid-switch used to release the in-flight lock
  // while the board fetch was still running, and the resolved fetch then
  // activated the old board and threw the form away — the #4166 symptom,
  // through this sheet.
  const handleCancel = useCallback(() => {
    if (busy) return;
    onDismiss();
  }, [busy, onDismiss]);

  const body = duplicate.locationName
    ? t('mobile.create.duplicate.bodyWithLocation', {
        name: duplicate.boardName,
        location: duplicate.locationName,
      })
    : t('mobile.create.duplicate.body', { name: duplicate.boardName });

  // The way out sits in the top bar. The two real choices stay in the body as
  // full-width buttons: they are peers, like an action sheet's, not a confirm.
  return (
    <ModalSheet
      visible
      snapPoints={SNAP_POINTS}
      // Pan-down is a second route to the same cancel, so it closes too.
      enablePanDownToClose={!busy}
      onClose={onDismiss}
      header={
        <SheetTopBar
          title={t('mobile.create.duplicate.title')}
          // Closing loses nothing: it means "keep editing" and nothing else.
          leading={{ kind: 'close', onPress: handleCancel, accessibilityLabel: t('mobile.create.duplicate.cancel') }}
        />
      }
    >
      <View style={styles.content}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
          {body}
        </Text>
        <Button
          title={t('mobile.create.duplicate.useExisting')}
          onPress={handleUseExisting}
          disabled={busy}
          loading={busy}
          size="medium"
          style={styles.fullWidth}
        />
        <View style={styles.addAnother}>
          <Button
            title={t('mobile.create.duplicate.addAnother')}
            onPress={handleAddAnother}
            disabled={busy}
            variant="tonal"
            size="medium"
            style={styles.fullWidth}
          />
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.centered}>
            {t('mobile.create.duplicate.addAnotherHint')}
          </Text>
        </View>
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
  addAnother: {
    gap: spacing[1],
  },
});
