import { useCallback, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { Card } from '../Card';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { ArtRow } from '../ArtRow';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { BoardThumbnail } from './BoardThumbnail';

/** The board fields shown at a glance — a structural subset of the active board. */
type BoardSummary = {
  name: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
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
export function BoardSummaryCard(props: BoardSummaryCardProps) {
  const { board } = props;
  // One element per board, so the Browse row's memo holds across re-renders.
  const thumbnail = useMemo(() => (board ? <BoardThumbnail board={board} size="regular" /> : null), [board]);
  return <BoardSummaryCardView {...props} thumbnail={thumbnail} />;
}
export function BoardSummaryCardView({
  thumbnail,
  onBrowseClimbs,
  onChangeBoard,
  onRetry,
  hasNoBoard,
  isRestoreError,
  board,
}: BoardSummaryCardProps & { thumbnail: ReactNode }) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { t: tClimbs } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const browseClimbs = useCallback(() => {
    hapticLight();
    onBrowseClimbs();
  }, [onBrowseClimbs]);
  const changeBoard = useCallback(() => {
    hapticLight();
    onChangeBoard();
  }, [onChangeBoard]);

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
    const browseTitle = t('mobile.session.browseClimbs');
    return (
      <InsetGroupedList>
        <ArtRow
          art={thumbnail}
          artSize="regular"
          title={browseTitle}
          subtitle={summary ?? undefined}
          accessory="chevron"
          onPress={browseClimbs}
          accessibilityLabel={[browseTitle, summary].filter(Boolean).join(', ')}
        />
        <PressableSurface
          onPress={changeBoard}
          feedback="opacity"
          rippleColor={systemColors.label as string}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.session.changeBoard')}
          style={insetGroupedRowStyles.row}
        >
          <View style={insetGroupedRowStyles.leading}>
            <Icon name="transfer" size={20} color={systemColors.secondaryLabel} />
          </View>
          <Text variant="body" color={systemColors.label} style={insetGroupedRowStyles.text}>
            {t('mobile.session.changeBoard')}
          </Text>
          <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
        </PressableSurface>
      </InsetGroupedList>
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
  actions: {
    gap: spacing[2],
    marginTop: spacing[3],
    alignItems: 'flex-start',
  },
});
