import { useEffect, useMemo, useRef } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import BottomSheet from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { LostHoldGhost, ReplacementCandidate } from '@boardsesh/create-climb-react';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius, opacity } from '../../theme/tokens';

type LostHoldSheetProps = {
  /** The tapped ghost, or null when the sheet is closed. */
  ghost: LostHoldGhost | null;
  /** What "Use a hold nearby" would highlight for it. */
  candidates: readonly ReplacementCandidate[];
  onUseNearby: () => void;
  /**
   * "Put this hold back on the wall": the hold editor, at the spot it was.
   * Offered to whoever can edit the wall's holds; omitted for everyone else.
   */
  onPutBack?: () => void;
  onClose: () => void;
};

type RoleKey = 'STARTING' | 'HAND' | 'FINISH' | 'FOOT';

/**
 * What to do about one lost hold (#5493). A sibling of the create drawer, like
 * `HoldRoleSheet`: two native sheets stack as siblings, never nested.
 */
export function LostHoldSheet({ ghost, candidates, onUseNearby, onPutBack, onClose }: LostHoldSheetProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const sheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    if (ghost) sheetRef.current?.snapToIndex(0);
    else sheetRef.current?.close();
  }, [ghost]);

  const snapPoints = useMemo(() => ['40%', '70%'], []);

  const roleLines: Record<RoleKey, string> = {
    STARTING: t('mobile.lostHolds.sheet.wasStart'),
    HAND: t('mobile.lostHolds.sheet.wasHand'),
    FINISH: t('mobile.lostHolds.sheet.wasFinish'),
    FOOT: t('mobile.lostHolds.sheet.wasFoot'),
  };
  const role = ghost?.role;
  const roleLine = role && role in roleLines ? roleLines[role as RoleKey] : null;

  const hasCandidates = candidates.length > 0;
  const hasSuccessor = candidates.some((candidate) => candidate.isSuccessor);
  const nearbyHint = !hasCandidates
    ? t('mobile.lostHolds.sheet.noneNearby')
    : hasSuccessor
      ? t('mobile.lostHolds.sheet.useNearbySuccessor')
      : t('mobile.lostHolds.sheet.useNearbyHint');

  return (
    <Sheet ref={sheetRef} snapPoints={snapPoints} onClose={onClose} enablePanDownToClose scrollable>
      <View style={styles.content} testID="lost-hold-sheet">
        <Text variant="headline" style={styles.centered}>
          {t('mobile.lostHolds.sheet.title')}
        </Text>
        {roleLine ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
            {roleLine}
          </Text>
        ) : null}
        <Pressable
          onPress={onUseNearby}
          disabled={!hasCandidates}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.lostHolds.sheet.useNearby')}
          accessibilityHint={nearbyHint}
          accessibilityState={{ disabled: !hasCandidates }}
          style={[styles.option, { backgroundColor: systemColors.fill }, !hasCandidates && styles.disabled]}
          testID="lost-hold-use-nearby"
        >
          <Icon name="hand.tap" size={20} color={systemColors.label} />
          <View style={styles.optionCopy}>
            <Text variant="subheadline" style={styles.optionTitle}>
              {t('mobile.lostHolds.sheet.useNearby')}
            </Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {nearbyHint}
            </Text>
          </View>
        </Pressable>
        {onPutBack ? (
          <Pressable
            onPress={onPutBack}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.lostHolds.sheet.putBack')}
            accessibilityHint={t('mobile.lostHolds.sheet.putBackHint')}
            style={[styles.option, { backgroundColor: systemColors.fill }]}
            testID="lost-hold-put-back"
          >
            <Icon name="add" size={20} color={systemColors.label} />
            <View style={styles.optionCopy}>
              <Text variant="subheadline" style={styles.optionTitle}>
                {t('mobile.lostHolds.sheet.putBack')}
              </Text>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('mobile.lostHolds.sheet.putBackHint')}
              </Text>
            </View>
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[3],
  },
  centered: {
    textAlign: 'center',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.md,
  },
  optionCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  optionTitle: {
    fontWeight: '600',
  },
  disabled: {
    opacity: opacity.disabled,
  },
});
