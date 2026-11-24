// The builder's hold sets in the main form (#8151): "Holds: 3 of 4 sets", so a
// climber sees a partial setup without opening anything, and a nudge for the
// set climbers forget ("Missing Screw-on Feet?") with a one-tap add. Partial
// setups stay allowed: the nudge never blocks Save.

import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { likelySetupOmissions } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { TextAction } from '../TextAction';

type BoardHoldsSummaryProps = {
  boardName: BoardName;
  layoutId: number | null;
  /** The sets the layout and size offer. */
  sets: readonly { id: number; name: string }[];
  /** The sets picked. */
  selectedSetIds: readonly number[];
  /** The set chips are showing. */
  expanded: boolean;
  onToggleExpanded: () => void;
  onAddSet: (setId: number) => void;
  /** The config is locked (an edit with ticks): the count only, no actions. */
  disabled?: boolean;
};

export const BoardHoldsSummary = memo(function BoardHoldsSummary({
  boardName,
  layoutId,
  sets,
  selectedSetIds,
  expanded,
  onToggleExpanded,
  onAddSet,
  disabled = false,
}: BoardHoldsSummaryProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();

  const selectedCount = useMemo(() => {
    const selected = new Set(selectedSetIds);
    return sets.filter((set) => selected.has(set.id)).length;
  }, [sets, selectedSetIds]);
  // Only a set this size offers can be added from here.
  const omissions = useMemo(() => {
    if (layoutId == null) return [];
    return likelySetupOmissions({ boardType: boardName, layoutId, setIds: selectedSetIds.join(',') }).flatMap(
      (hint) => {
        const set = sets.find((candidate) => candidate.id === hint.setId);
        return set ? [{ setId: set.id, name: set.name.trim() }] : [];
      },
    );
  }, [boardName, layoutId, selectedSetIds, sets]);

  if (sets.length === 0) return null;

  return (
    <View style={styles.container} testID="board-holds-summary">
      <View style={styles.summaryRow}>
        <Text variant="body" style={styles.summaryText} testID="board-holds-count">
          {t('mobile.create.holdsSummary', { selected: selectedCount, count: sets.length })}
        </Text>
        {disabled ? null : (
          <TextAction
            label={expanded ? t('mobile.create.holdsDone') : t('mobile.create.holdsChange')}
            accessibilityLabel={expanded ? t('mobile.create.holdsDone') : t('mobile.create.holdsChangeLabel')}
            onPress={onToggleExpanded}
          />
        )}
      </View>
      {disabled
        ? null
        : omissions.map((omission) => (
            <View
              key={omission.setId}
              style={[styles.omission, { borderColor: brandColors.warning }]}
              testID={`board-holds-omission-${omission.setId}`}
            >
              <Icon name="info" size={16} color={brandColors.warning} />
              <Text variant="footnote" color={systemColors.label} style={styles.omissionText}>
                {t('mobile.create.omissionHint', { set: omission.name })}
              </Text>
              <Button
                title={t('mobile.create.omissionAdd', { set: omission.name })}
                variant="text"
                size="small"
                onPress={() => onAddSet(omission.setId)}
                testID={`board-holds-add-${omission.setId}`}
              />
            </View>
          ))}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[2],
    marginTop: spacing[2],
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
  summaryText: {
    flex: 1,
  },
  omission: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingLeft: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  omissionText: {
    flex: 1,
  },
});
