import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Appbar } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { canAdjustBoardAngle, type BoardAngleFields } from '../../lib/boards/can-adjust-board-angle';
import { ShowcaseAnchorView } from '../../lib/showcase-anchor';
import { hapticLight } from '../../lib/haptics';
import { AppMenu } from '../AppMenu';
import type { AppMenuAction } from '../AppMenu.types';
import { Icon } from '../Icon';
import { Badge } from '../Badge';
import { iconMap } from '../icon-map';
import { AngleToolbarAction } from './AngleToolbarAction';
import { GlassToolbarAction, toolbarGlyphSize, useToolbarActionSize } from './GlassActionToolbar';

type ClimbListBoardActionsProps = {
  onOpenHistory: () => void;
  badge?: boolean;
  showcaseAnchor?: boolean;
  material?: boolean;
};

type ListMenuRow = AppMenuAction & { id: 'viewOptions' | 'switchBoard' };

type CountedBoard = NonNullable<Parameters<typeof formatActiveBoardLabel>[0]> & BoardAngleFields;

/**
 * How many glass toolbar slots `ClimbListBoardActions` fills for this board:
 * the angle (adjustable boards), history (any board with a label) and the ⋯
 * menu. Read from the same conditions the component renders on.
 */
export function climbListBoardActionCount(activeBoard: CountedBoard | null | undefined): number {
  const angle = canAdjustBoardAngle(activeBoard) ? 1 : 0;
  const history = formatActiveBoardLabel(activeBoard) ? 1 : 0;
  return angle + history + 1;
}

/**
 * The Climbs list's trailing board actions. Liquid Glass: the one-tap angle,
 * history, then the ⋯ menu (View options, Switch board). Material leaves the
 * angle to the filter row's Angle chip, so it keeps history and the menu.
 */
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
  const rows = useMemo<ListMenuRow[]>(
    () => [
      { id: 'viewOptions', label: t('mobile.listOptions.viewOptions'), systemIcon: iconMap['view.options'].ios },
      {
        id: 'switchBoard',
        label: tSession('mobile.boardPresence.switchBoard'),
        systemIcon: 'arrow.left.arrow.right',
        dividerBefore: true,
      },
    ],
    [t, tSession],
  );
  const rowSignature = rows.map((row) => `${row.id}:${row.label}`).join('|');
  const handleOpenHistory = useCallback(() => {
    hapticLight();
    onOpenHistory();
  }, [onOpenHistory]);

  return (
    <>
      {material ? null : <AngleToolbarAction />}
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
                <Icon
                  maxFontSizeMultiplier={1}
                  name="history"
                  size={toolbarGlyphSize(23, actionSize)}
                  color={systemColors.label}
                />
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
      <View style={[styles.menu, !material && { width: actionSize, height: actionSize }]}>
        <AppMenu
          // Native popups retain their row indices until dismissed. Remount on
          // board/row changes rather than let an old tap select a moved row.
          key={`${activeBoard?.uuid ?? 'none'}|${rowSignature}`}
          iconName="more"
          iconAppearance="plain"
          // The ⋯ fills its toolbar slot (38pt in UIKit's bar); Material keeps M3's.
          anchorSize={material ? undefined : actionSize}
          accessibilityLabel={t('mobile.listOptions.title')}
          actions={rows}
          onSelectIndex={(index) => {
            switch (rows[index]?.id) {
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
    </>
  );
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', top: 2, right: 2 },
  menu: { alignItems: 'center', justifyContent: 'center' },
});
