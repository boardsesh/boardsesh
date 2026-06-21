import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { Card } from '../../Card';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
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
  /** Open the board switcher (the Boards tab, where the cascading picker lives). */
  onPress: () => void;
  /** The active board, or null when none is set. Drives summary-vs-prompt. */
  board?: BoardSummary | null;
};

/**
 * Pre-session board row. When a board is set it shows the config at a glance
 * (name · size · angle) — the chrome pill carries the same identity but collapses
 * on scroll, so this keeps the full config (incl. size) persistently visible.
 * When none is set it's a prompt guiding the climber to the Boards tab. Laid out
 * as a `ListRow`-style leading icon / label / chevron inside `Card` (so it picks
 * up the glass-vs-material surface) without `ListRow`'s extra inset doubling the
 * card padding.
 */
export function BoardSummaryCard({ onPress, board }: BoardSummaryCardProps) {
  const { t } = useTranslation('session');
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
    <Card onPress={onPress}>
      <View style={styles.row}>
        <Icon name="boards" size={22} color={systemColors.secondaryLabel} />
        <View style={styles.textColumn}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.session.preBoardLabel')}
          </Text>
          <Text variant="body" color={systemColors.label}>
            {summary ?? t('mobile.session.preNoBoard')}
          </Text>
        </View>
        <Icon name="chevron.right" size={18} color={systemColors.tertiaryLabel} />
      </View>
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
});
