import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { LedgerAngleSection } from '@boardsesh/profile-stats';
import { Text } from '../../Text';
import { formatAngleResult } from './angle-result';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';

type LogbookAngleHeaderProps = {
  section: LedgerAngleSection<unknown>;
  /** The board is set to this section's angle. */
  isBoardAngle: boolean;
  /**
   * Adds that angle's story, e.g. "Sent in session 3 · 13 tries over 3
   * sessions". The card leaves it off the board's angle, where the line under
   * the verdict already tells it.
   */
  showStory: boolean;
};

/**
 * Heads one angle's days as plain text: the angle, "board is here" when the
 * board is set to it, and that angle's story.
 */
export const LogbookAngleHeader = memo(function LogbookAngleHeader({
  section,
  isBoardAngle,
  showStory,
}: LogbookAngleHeaderProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  const parts: string[] = [];
  if (isBoardAngle) parts.push(t('mobile.logbook.angleBoardIsHere'));
  if (showStory) {
    // Segments pluralize individually; the TEMPLATES own word order and joining
    // so a locale can rearrange the clauses.
    const recap = t('mobile.logbook.lifetimeRecap', {
      tries: t('mobile.logbook.lifetimeTries', { count: section.totalTries }),
      sessions: t('mobile.logbook.lifetimeSessions', { count: section.sessionCount }),
    });
    parts.push(t('mobile.logbook.angleLine', { result: formatAngleResult(t, section), recap }));
  }
  const angleLabel = `${section.angle}°`;

  return (
    // The rule sits on a View: a per-side border on a Text does not draw on iOS.
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={[angleLabel, ...parts].join(', ')}
      style={[styles.header, { borderTopColor: systemColors.separator }]}
    >
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        <Text variant="footnote" color={systemColors.label} style={styles.angle}>
          {angleLabel}
        </Text>
        {parts.map((part) => ` · ${part}`).join('')}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  header: {
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  angle: {
    fontWeight: '600',
  },
});
