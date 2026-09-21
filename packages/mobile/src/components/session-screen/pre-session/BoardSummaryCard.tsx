import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { Card } from '../../Card';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { Button } from '../../Button';
import { PressableSurface } from '../../PressableSurface';
import { useTheme } from '../../../providers/theme-provider';
import { hapticLight } from '../../../lib/haptics';
import { spacing } from '../../../theme/tokens';

/** The board fields shown at a glance — a structural subset of the active board. */
type BoardSummary = {
  name: string;
  boardType: string;
  sizeName?: string | null;
  angle?: number | null;
};

type BoardSummaryCardProps = {
  onBrowseClimbs: () => void;
  onChangeBoard: () => void;
  onRetry: () => void;
  hasNoBoard: boolean;
  isRestoreError: boolean;
  /** The active board, or null when none is set. Drives summary-vs-prompt. */
  board?: BoardSummary | null;
};

/**
 * Two grouped navigation rows: browse this board, or explicitly change it.
 * The static card contains sibling pressables, so each action owns its whole
 * row and long board names can wrap without shrinking either touch target.
 */
export function BoardSummaryCard({
  onBrowseClimbs,
  onChangeBoard,
  onRetry,
  hasNoBoard,
  isRestoreError,
  board,
}: BoardSummaryCardProps) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { t: tClimbs } = useTranslation('climbs');
  const { systemColors } = useTheme();

  const summary = board
    ? [
        board.name || formatBoardDisplayName(board.boardType),
        board.sizeName,
        board.angle != null ? `${board.angle}°` : null,
      ]
        .filter((part): part is string => !!part)
        .join(' · ')
    : null;

  if (board) {
    return (
      <Card style={styles.groupedCard}>
        <View style={styles.groupedRows}>
          <PressableSurface
            onPress={() => {
              hapticLight();
              onBrowseClimbs();
            }}
            feedback="opacity"
            rippleColor={systemColors.label as string}
            accessibilityRole="button"
            accessibilityLabel={[t('mobile.session.browseClimbs'), summary].filter(Boolean).join(', ')}
            style={styles.navigationRow}
          >
            <View style={styles.iconColumn}>
              <Icon name="search" size={22} color={systemColors.label} />
            </View>
            <View style={styles.textColumn}>
              <Text variant="headline" color={systemColors.label}>
                {t('mobile.session.browseClimbs')}
              </Text>
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {summary}
              </Text>
            </View>
            <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
          </PressableSurface>
          <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
          <PressableSurface
            onPress={() => {
              hapticLight();
              onChangeBoard();
            }}
            feedback="opacity"
            rippleColor={systemColors.label as string}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.session.changeBoard')}
            style={styles.navigationRow}
          >
            <View style={styles.iconColumn}>
              <Icon name="boards" size={22} color={systemColors.secondaryLabel} />
            </View>
            <Text variant="body" color={systemColors.label} style={styles.actionLabel}>
              {t('mobile.session.changeBoard')}
            </Text>
            <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
          </PressableSurface>
        </View>
      </Card>
    );
  }

  return (
    <Card>
      <View style={styles.row}>
        <Icon name="boards" size={22} color={systemColors.secondaryLabel} />
        <View style={styles.textColumn}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.session.preBoardLabel')}
          </Text>
          <Text variant="body" color={systemColors.label}>
            {isRestoreError
              ? tClimbs('mobile.emptyState.boardRestoreFailed.title')
              : hasNoBoard
                ? t('mobile.session.noBoardSelected')
                : tCommon('actions.loading')}
          </Text>
        </View>
      </View>
      {isRestoreError ? (
        <View style={styles.actions}>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {tClimbs('mobile.emptyState.boardRestoreFailed.description')}
          </Text>
          <Button title={tCommon('actions.retry')} onPress={onRetry} variant="outlined" />
        </View>
      ) : hasNoBoard ? (
        <View style={styles.actions}>
          <Button title={t('mobile.session.chooseBoard')} onPress={onChangeBoard} variant="outlined" />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  groupedCard: {
    overflow: 'hidden',
  },
  groupedRows: {
    // Both Card variants inset content by 16pt. Let each row own that gutter
    // so the whole surface is tappable, including around the label and icon.
    margin: -spacing[4],
  },
  navigationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: spacing[12],
  },
  iconColumn: {
    width: spacing[6],
    flexShrink: 0,
    alignItems: 'center',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[4] + spacing[6] + spacing[3],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
    gap: spacing[1],
  },
  actionLabel: {
    flex: 1,
    minWidth: 0,
  },
  actions: {
    gap: spacing[2],
    marginTop: spacing[3],
    alignItems: 'flex-start',
  },
});
