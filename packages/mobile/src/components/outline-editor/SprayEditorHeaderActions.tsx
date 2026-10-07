import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';

/** The "?" glyph, the size the header's other glyphs draw at. */
const HELP_ICON_SIZE = 22;

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
 * Neutral label colour and a semibold weight, the header's own way of marking
 * the action that finishes the screen, and a spinner in place of the label
 * while it works.
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
  const { systemColors } = useTheme();
  const disabled = primaryDisabled || primaryLoading;
  return (
    <View style={styles.row}>
      {onHelp ? (
        <PressableSurface
          testID="spray-editor-help"
          onPress={onHelp}
          disabled={helpDisabled}
          feedback="opacity"
          hitSlop={spacing[1]}
          accessibilityRole="button"
          accessibilityLabel={t('sprayEditor.hints.replay')}
          accessibilityState={{ disabled: helpDisabled }}
          style={[styles.help, helpDisabled ? styles.dimmed : null]}
        >
          <Icon name="help" size={HELP_ICON_SIZE} color={systemColors.label} />
        </PressableSurface>
      ) : null}
      <PressableSurface
        testID="spray-editor-primary"
        onPress={onPrimary}
        disabled={disabled}
        feedback="opacity"
        hitSlop={spacing[1]}
        accessibilityRole="button"
        accessibilityLabel={primaryLabel}
        accessibilityState={{ disabled, busy: primaryLoading }}
        style={styles.primary}
      >
        {primaryLoading ? (
          <ActivityIndicator />
        ) : (
          <Text
            variant="body"
            color={primaryDisabled ? systemColors.tertiaryLabel : systemColors.label}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.primaryLabel}
          >
            {primaryLabel}
          </Text>
        )}
      </PressableSurface>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  help: {
    width: glassSize.mini,
    height: glassSize.mini,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    minHeight: glassSize.mini,
    minWidth: glassSize.capsule,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: {
    fontWeight: '600',
  },
  dimmed: {
    opacity: 0.4,
  },
});
