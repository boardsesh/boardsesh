import { useMemo } from 'react';
import { boardSupportsMirroring } from '@boardsesh/board-config';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ClimbRowDisplay, ClimbRowPresetId } from '../../../lib/climb-row-display';
import { useBoardPreviewClimb } from '../../../hooks/use-board-preview-climb';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { ClimbListItemContent, type ClimbListItemClimb } from '../../ClimbListItemContent';
import { Icon } from '../../Icon';
import { climbRowLayout } from '../../climb-row-layout';
import { ClimbRowPresetChips } from './ClimbRowPresetChips';
import { CLIMB_ROW_PREVIEW_LEAVES, CLIMB_ROW_PLAIN_PREVIEW_LEAVES } from './climb-row-preview-leaves';

export function ClimbRowSettingsPreview({
  display,
  activePreset,
  hasLastCustom,
  selectPreset,
  windowHeight,
}: {
  display: ClimbRowDisplay;
  activePreset: ClimbRowPresetId | 'custom';
  hasLastCustom: boolean;
  selectPreset: (preset: ClimbRowPresetId | 'custom') => void;
  windowHeight: number;
}) {
  const { t } = useTranslation('common');
  const { systemColors, textStyles } = useTheme();
  const { fontScale } = useWindowDimensions();
  const { preview, climb } = useBoardPreviewClimb();
  const example = useMemo<ClimbListItemClimb>(
    () =>
      climb ?? {
        uuid: 'climb-row-example',
        name: t('mobile.settings.climbList.sampleName'),
        frames: 'p1r12',
        difficulty: '6b/V4',
        quality_average: '4.5',
        ascensionist_count: 1200,
        setter_username: t('mobile.settings.climbList.sampleSetter'),
      },
    [climb, t],
  );
  const rowDisplay = display;
  const geometry = climbRowLayout({
    display: rowDisplay,
    fontScale,
    typeScale: textStyles,
    supportsMirroring: boardSupportsMirroring(preview?.boardName ?? 'kilter', preview?.layoutId ?? 0),
    surface: { showAscentStatus: true, showPlaylistChips: true, showProgress: true, detailLine: 'computed' },
  });
  const showSecond = geometry.estimatedHeight * 2 <= windowHeight;
  const row = (plain: boolean) => (
    <View style={[styles.row, { minHeight: geometry.estimatedHeight }]}>
      <View style={styles.content}>
        <ClimbListItemContent
          climb={example}
          boardName={preview?.boardName ?? 'kilter'}
          layoutId={preview?.layoutId ?? 0}
          sizeId={preview?.sizeId ?? 0}
          setIds={preview?.setIds ?? ''}
          angle={preview?.angle ?? 40}
          display={rowDisplay}
          leaves={plain ? CLIMB_ROW_PLAIN_PREVIEW_LEAVES : CLIMB_ROW_PREVIEW_LEAVES}
          showFavorite={!plain}
          showPlaylistChips={!plain}
          showProgress
        />
      </View>
      {display.quickActions ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.actions}>
          <Icon name="more.vertical" size={20} color={systemColors.secondaryLabel} />
        </View>
      ) : null}
    </View>
  );
  return (
    <View>
      <View
        style={[styles.window, { height: windowHeight, backgroundColor: systemColors.secondaryBackground }]}
        pointerEvents="none"
      >
        {row(false)}
        {showSecond ? row(true) : null}
      </View>
      <ClimbRowPresetChips activePreset={activePreset} hasLastCustom={hasLastCustom} onSelect={selectPreset} />
    </View>
  );
}
const styles = StyleSheet.create({
  window: { overflow: 'hidden', justifyContent: 'flex-start' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    gap: spacing[3],
  },
  content: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  actions: { width: 44, alignItems: 'center', marginEnd: -Math.min(spacing[4], (44 - 20) / 2) },
});
