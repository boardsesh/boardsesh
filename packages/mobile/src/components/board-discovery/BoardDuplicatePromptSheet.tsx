// Shown when createBoard reports the user already owns a board with this
// configuration at this place. Replaces the silent auto-activate that caused
// #4166, where a climber's new-gym board was thrown away and their OLD board was
// quietly made active instead — with no message either way.
//
// Three outcomes, all explicit. Deliberately not `useConfirm()`: a two-button
// confirm has to map a scrim/back dismissal onto one of the real choices, and
// choosing silently on the user's behalf is the exact bug being fixed here.
// Dismissing this sheet means "keep editing" and nothing else.

import { useCallback, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { DuplicateBoardError } from '../../lib/graphql/extract-error-message';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';

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
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);

  const snapPoints = useMemo(() => androidSafeSnapPoints(['45%']), []);
  // Presence-driven: the host mounts this only while a duplicate is pending, so
  // `open` is constant true and the coordinator handles present/dismiss. An
  // imperative present() from a visible-prop effect is a silent no-op here.
  const managed = useManagedSheet({ open: true, sheetRef, onClose: onDismiss });

  const handleUseExisting = useCallback(() => {
    if (busy) return;
    onUseExisting();
  }, [busy, onUseExisting]);

  const handleAddAnother = useCallback(() => {
    if (busy) return;
    onAddAnother();
  }, [busy, onAddAnother]);

  const body = duplicate.locationName
    ? t('mobile.create.duplicate.bodyWithLocation', {
        name: duplicate.boardName,
        location: duplicate.locationName,
      })
    : t('mobile.create.duplicate.body', { name: duplicate.boardName });

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      // Pan-down is a second route to the same cancel, so it closes too.
      enablePanDownToClose={!busy}
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={styles.indicator}
    >
      <BottomSheetView style={styles.header}>
        <Text variant="title3" color={systemColors.label}>
          {t('mobile.create.duplicate.title')}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
          {body}
        </Text>
      </BottomSheetView>

      <View style={[styles.actions, { paddingBottom: insets.bottom + spacing[3] }]}>
        <Button
          title={t('mobile.create.duplicate.useExisting')}
          onPress={handleUseExisting}
          disabled={busy}
          loading={busy}
          size="medium"
        />
        <View style={styles.addAnother}>
          <Button
            title={t('mobile.create.duplicate.addAnother')}
            onPress={handleAddAnother}
            disabled={busy}
            variant="tonal"
            size="medium"
          />
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.centered}>
            {t('mobile.create.duplicate.addAnotherHint')}
          </Text>
        </View>
        {/* Also disabled while busy: cancelling mid-switch used to release the
            in-flight lock while the board fetch was still running, and the
            resolved fetch then activated the old board and threw the form away —
            the #4166 symptom, through this sheet. */}
        <Button
          title={t('mobile.create.duplicate.cancel')}
          onPress={onDismiss}
          disabled={busy}
          variant="text"
          size="medium"
          role="cancel"
        />
      </View>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  indicator: {
    backgroundColor: iosSystemColors.separator,
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    alignItems: 'center',
    gap: 4,
  },
  centered: {
    textAlign: 'center',
  },
  actions: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[3],
  },
  addAnother: {
    gap: 4,
  },
});
