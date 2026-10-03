import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { LedgerTryMark } from '@boardsesh/profile-stats';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { useTheme } from '../../../providers/theme-provider';
import { iosSystemColors } from '../../../theme/ios-colors';

type TryDotsProps = {
  /** Oldest try first. Bounded by the ledger: 40 falls plus the day's sends. */
  marks: readonly LedgerTryMark[];
  /** Falls the ledger left out of `marks`. */
  overflowTries: number;
};

const DOT_SIZE = 10;

/**
 * One mark per try in a session: a ring for a fall, a filled green dot for the
 * send, a bolt for a flash. The three differ by shape as well as colour. The
 * tile's own summary ("5 tries · sent") says the same thing in words, so the
 * dots stay out of the accessibility tree.
 */
export const TryDots = memo(function TryDots({ marks, overflowTries }: TryDotsProps) {
  const { t } = useTranslation('session');
  const { brandColors, systemColors } = useTheme();

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.row}
    >
      {overflowTries > 0 ? (
        <Text variant="caption2" color={systemColors.secondaryLabel}>
          {t('mobile.logbook.moreTries', { count: overflowTries })}
        </Text>
      ) : null}
      {marks.map((mark, index) => {
        // Position is the identity: the row is a fixed sequence, never reordered.
        const key = `${index}:${mark}`;
        if (mark === 'flash') return <Icon key={key} name="flash" size={DOT_SIZE} color={brandColors.primary} />;
        return (
          <View
            key={key}
            testID={`try-dot-${mark}`}
            style={[
              styles.dot,
              mark === 'send'
                ? { backgroundColor: iosSystemColors.systemGreen, borderColor: iosSystemColors.systemGreen }
                : { borderColor: systemColors.secondaryLabel },
            ]}
          />
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 3,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: 1.5,
  },
});
