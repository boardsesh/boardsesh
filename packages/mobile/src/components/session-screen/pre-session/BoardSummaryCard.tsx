import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { Card } from '../../Card';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { Button } from '../../Button';
import { useTheme } from '../../../providers/theme-provider';
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
 * Session board context with separate browse and switch actions. Keeping the
 * card itself static avoids nesting pressables or making a saved board look
 * like a required selection step every time the climber returns here.
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

  return (
    <Card>
      <View style={styles.row}>
        <Icon name="boards" size={22} color={systemColors.secondaryLabel} />
        <View style={styles.textColumn}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.session.preBoardLabel')}
          </Text>
          <Text variant="body" color={systemColors.label}>
            {summary ??
              (isRestoreError
                ? tClimbs('mobile.emptyState.boardRestoreFailed.title')
                : hasNoBoard
                  ? t('mobile.session.noBoardSelected')
                  : tCommon('actions.loading'))}
          </Text>
        </View>
      </View>
      {board ? (
        <View style={styles.actions}>
          <Button title={t('mobile.session.browseClimbs')} onPress={onBrowseClimbs} variant="outlined" />
          <Button title={t('mobile.session.changeBoard')} onPress={onChangeBoard} variant="text" />
        </View>
      ) : isRestoreError ? (
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  textColumn: {
    flex: 1,
    gap: 2,
  },
  actions: {
    gap: spacing[2],
    marginTop: spacing[3],
    alignItems: 'flex-start',
  },
});
