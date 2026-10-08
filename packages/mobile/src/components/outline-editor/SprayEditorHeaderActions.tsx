import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ChromeIconButton } from '../ChromeIconButton';
import { HeaderTrailingButton } from '../HeaderActionButtons';
import { spacing } from '../../theme/tokens';

type SprayEditorHeaderActionsProps = {
  /** The primary button's label: "Publish holds", or "Pick a look" in the add-a-wall flow. */
  primaryLabel: string;
  /** A commit is in flight: a spinner stands in for the label. */
  primaryLoading: boolean;
  /** Nothing ON yet, a Corners outline half placed, Refine open, or the wall locked. */
  primaryDisabled: boolean;
  onPrimary: () => void;
  /** Replays the hints. Omitted hides the "?" (screenshot mode). */
  onHelp?: () => void;
  helpDisabled: boolean;
};

/**
 * The phone hold editor's top-right corner, set as the screen's `headerRight`
 * by `SprayHoldEditorScreen`: "?" for the tips, then the button that saves the
 * holds and moves on. In the header rather than the bottom bar so the bar is
 * one row and the photo keeps the room.
 *
 * The primary is the header's prominent confirm (HeaderTrailingButton): brand
 * semibold, a spinner in place of the label while it works. The "?" is the
 * shared header glyph button, so both match every other header.
 */
export const SprayEditorHeaderActions = React.memo(function SprayEditorHeaderActions({
  primaryLabel,
  primaryLoading,
  primaryDisabled,
  onPrimary,
  onHelp,
  helpDisabled,
}: SprayEditorHeaderActionsProps) {
  const { t } = useTranslation('boards');
  return (
    <View style={styles.row}>
      {onHelp ? (
        <ChromeIconButton
          testID="spray-editor-help"
          appearance="bare"
          role="action"
          icon="help"
          onPress={onHelp}
          disabled={helpDisabled}
          accessibilityLabel={t('sprayEditor.hints.replay')}
        />
      ) : null}
      {/* Forward text, not the ✓: "Pick a look" moves on, and the label says which. */}
      <HeaderTrailingButton
        testID="spray-editor-primary"
        kind="forward"
        label={primaryLabel}
        onPress={onPrimary}
        disabled={primaryDisabled}
        loading={primaryLoading}
        prominent
      />
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
});
