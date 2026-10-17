import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Appbar } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { ShowcaseAnchorView } from '../../lib/showcase-anchor';
import { hapticLight } from '../../lib/haptics';
import { AppMenu } from '../AppMenu';
import type { AppMenuAction } from '../AppMenu.types';
import { Icon } from '../Icon';
import { Badge } from '../Badge';
import { iconMap } from '../icon-map';
import { BoardAnglePicker } from './BoardAnglePicker';
import { GlassToolbarAction, useToolbarActionSize } from './GlassActionToolbar';

type ClimbListBoardActionsProps = {
  onOpenHistory: () => void;
  badge?: boolean;
  showcaseAnchor?: boolean;
  material?: boolean;
};

type ListMenuRow = AppMenuAction & { id: 'angle' | 'viewOptions' | 'switchBoard' };

/** History keeps its own target; list and board options share the native menu. */
export function ClimbListBoardActions({
  onOpenHistory,
  badge = false,
  showcaseAnchor = false,
  material = false,
}: ClimbListBoardActionsProps) {
  const { t } = useTranslation('climbs');
  const { t: tSession } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { data: activeBoard } = useActiveBoard();
  const router = useRouter();
  const actionSize = useToolbarActionSize();
  const boardLabel = formatActiveBoardLabel(activeBoard);
  const canAdjust = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;
  const rows = useMemo<ListMenuRow[]>(
    () => [
      ...(canAdjust && activeBoard
        ? [
            {
              id: 'angle' as const,
              label: t('mobile.listOptions.angle', { angle: activeBoard.angle }),
              systemIcon: 'angle',
            },
          ]
        : []),
      { id: 'viewOptions', label: t('mobile.listOptions.viewOptions'), systemIcon: iconMap['view.options'].ios },
      {
        id: 'switchBoard',
        label: tSession('mobile.boardPresence.switchBoard'),
        systemIcon: 'arrow.left.arrow.right',
        dividerBefore: true,
      },
    ],
    [activeBoard, canAdjust, t, tSession],
  );
  const rowSignature = rows.map((row) => `${row.id}:${row.label}`).join('|');
  const handleOpenHistory = useCallback(() => {
    hapticLight();
    onOpenHistory();
  }, [onOpenHistory]);

  return (
    <>
      {boardLabel ? (
        <ShowcaseAnchorView name="board-history-button" enabled={showcaseAnchor}>
          <View>
            {material ? (
              <Appbar.Action
                icon={iconMap.history.android}
                color={systemColors.label as string}
                onPress={handleOpenHistory}
                accessibilityLabel={t('mobile.listOptions.history', { board: boardLabel })}
                accessibilityHint={t('mobile.listOptions.historyHint')}
              />
            ) : (
              <GlassToolbarAction
                onPress={handleOpenHistory}
                accessibilityLabel={t('mobile.listOptions.history', { board: boardLabel })}
                accessibilityHint={t('mobile.listOptions.historyHint')}
              >
                <Icon maxFontSizeMultiplier={1} name="history" size={23} color={systemColors.label} />
              </GlassToolbarAction>
            )}
            {badge ? (
              <View style={styles.badge} pointerEvents="none">
                <Badge visible color={brandColors.primary} size="small" />
              </View>
            ) : null}
          </View>
        </ShowcaseAnchorView>
      ) : null}
      <BoardAnglePicker>
        {(openAngle) => (
          <View style={[styles.menu, !material && { width: actionSize, height: actionSize }]}>
            <AppMenu
              // Native popups retain their row indices until dismissed. Remount on
              // board/row changes rather than let an old tap select a moved row.
              key={`${activeBoard?.uuid ?? 'none'}|${rowSignature}`}
              iconName="more"
              iconAppearance="plain"
              accessibilityLabel={t('mobile.listOptions.title')}
              actions={rows}
              onSelectIndex={(index) => {
                switch (rows[index]?.id) {
                  case 'angle':
                    openAngle();
                    break;
                  case 'viewOptions':
                    router.push('/(tabs)/climbs/settings/climb-list');
                    break;
                  case 'switchBoard':
                    router.push('/boards');
                    break;
                }
              }}
            />
          </View>
        )}
      </BoardAnglePicker>
    </>
  );
}

/** Material retains the active board as a static title beside trailing actions. */
export function ClimbListBoardTitle() {
  const { data: activeBoard } = useActiveBoard();
  return <Appbar.Content title={formatActiveBoardLabel(activeBoard) ?? ''} />;
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', top: 2, right: 2 },
  menu: { alignItems: 'center', justifyContent: 'center' },
});
