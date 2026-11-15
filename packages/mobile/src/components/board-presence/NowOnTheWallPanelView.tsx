import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { SwitchBoardFooter } from './SwitchBoardFooter';
import { styles } from './wall-panel-styles';
export function NowOnTheWallPanelView({
  variant,
  boardLabel,
  headerTopPadding,
  footerBottomPadding,
  onClose,
  canSwitchGymWall = false,
  gymWallsExpanded = false,
  onToggleGymWalls,
  onSwitchBoard,
  list,
}: {
  variant: 'sheet' | 'column' | 'tab';
  boardLabel?: string | null;
  headerTopPadding: number;
  footerBottomPadding: number;
  onClose?: () => void;
  canSwitchGymWall?: boolean;
  gymWallsExpanded?: boolean;
  onToggleGymWalls?: () => void;
  onSwitchBoard: () => void;
  list: ReactNode;
}) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  return (
    <>
      <View style={[styles.header, { borderBottomColor: systemColors.separator, paddingTop: headerTopPadding }]}>
        {onClose ? (
          <PressableSurface
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.boardPresence.close')}
            style={styles.headerAction}
          >
            <Icon name="chevron.down" size={20} color={systemColors.secondaryLabel} />
          </PressableSurface>
        ) : (
          <View pointerEvents="none" style={styles.headerAction} />
        )}
        <Text variant="title3" color={systemColors.label} numberOfLines={1} style={styles.headerTitle}>
          {boardLabel ?? t('mobile.boardPresence.title')}
        </Text>
        {canSwitchGymWall ? (
          // Mirrors the close control on the left, in the slot that was already
          // a dead spacer holding the title centred — so the switch costs no
          // vertical space at all. A transfer glyph, not a caret: this moves you
          // to another board rather than revealing more of this one.
          <PressableSurface
            onPress={onToggleGymWalls}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ expanded: gymWallsExpanded }}
            accessibilityLabel={t('mobile.boardPresence.gymWalls.headerSwitcherAria', {
              board: boardLabel ?? '',
            })}
            accessibilityHint={t(
              gymWallsExpanded
                ? 'mobile.boardPresence.gymWalls.headerSwitcherHintClose'
                : 'mobile.boardPresence.gymWalls.headerSwitcherHintOpen',
            )}
            style={styles.headerAction}
          >
            <Icon
              name="transfer"
              size={20}
              color={gymWallsExpanded ? brandColors.primary : systemColors.secondaryLabel}
            />
          </PressableSurface>
        ) : (
          <View pointerEvents="none" style={styles.headerAction} />
        )}
      </View>

      {list}

      {variant === 'column' ? (
        <SwitchBoardFooter boardLabel={boardLabel} onPress={onSwitchBoard} bottomPadding={footerBottomPadding} />
      ) : null}
    </>
  );
}
