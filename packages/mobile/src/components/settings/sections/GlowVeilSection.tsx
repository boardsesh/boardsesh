import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SectionHeader } from '../../SectionHeader';
import { SegmentedControl } from '../../SegmentedControl';
import { useTheme } from '../../../providers/theme-provider';
import {
  BOARD_RENDER_SETTING_BOUNDS,
  GLOW_FALLOFF_OPTIONS,
  VEIL_OPTIONS,
  type BoardseshRenderSettings,
  type GlowFalloffSetting,
  type VeilSetting,
} from '../../../lib/board-render-settings';
import { borderRadius, spacing } from '../../../theme/tokens';
import { MarkerMultiplierSlider, useCommittedSliderValue } from '../MarkerMultiplierSlider';

type GlowVeilSectionProps = {
  boardsesh: BoardseshRenderSettings;
  /** The falloff this render actually uses right now (`default` resolved). Only
   *  gates the plateau-share slider — it must track what's on the wall, not just
   *  the raw picker, so a future rollout flag resolving `default` to `plateau`
   *  still surfaces the slider. */
  effectiveGlowFalloff: 'soft' | 'plateau';
  setBoardseshField: <Field extends keyof BoardseshRenderSettings>(
    field: Field,
    value: BoardseshRenderSettings[Field],
  ) => void;
};

export function GlowVeilSection({ boardsesh, effectiveGlowFalloff, setBoardseshField }: GlowVeilSectionProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();

  const falloffOptions = useMemo<{ key: GlowFalloffSetting; label: string }[]>(
    () =>
      GLOW_FALLOFF_OPTIONS.map((option) => ({
        key: option,
        label: t(`mobile.more.boardLook.glowVeil.falloff.options.${option}`),
      })),
    [t],
  );
  const veilOptions = useMemo<{ key: VeilSetting; label: string }[]>(
    () =>
      VEIL_OPTIONS.map((option) => ({
        key: option,
        label: t(`mobile.more.boardLook.glowVeil.veil.options.${option}`),
      })),
    [t],
  );

  const reach = useCommittedSliderValue(boardsesh.glowReach, (value) => setBoardseshField('glowReach', value));
  const plateauShare = useCommittedSliderValue(boardsesh.plateauShare, (value) =>
    setBoardseshField('plateauShare', value),
  );
  const veilOpacity = useCommittedSliderValue(boardsesh.veilOpacity, (value) =>
    setBoardseshField('veilOpacity', value),
  );

  return (
    <View style={styles.section}>
      <SectionHeader title={t('mobile.more.boardLook.glowVeil.title')} />
      <View style={[styles.card, styles.cardPadded, { backgroundColor: systemColors.secondaryBackground }]}>
        <SegmentedControl
          options={falloffOptions}
          selectedKey={boardsesh.glowFalloff}
          onSelect={(value) => setBoardseshField('glowFalloff', value)}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.more.boardLook.glowVeil.falloff.title')}
        />

        <MarkerMultiplierSlider
          accessibilityLabel={t('mobile.more.boardLook.glowVeil.reach.title')}
          value={reach.draftValue}
          min={BOARD_RENDER_SETTING_BOUNDS.glowReach.min}
          max={BOARD_RENDER_SETTING_BOUNDS.glowReach.max}
          step={0.1}
          format={(value) => t('mobile.more.boardLook.glowVeil.reach.value', { value: value.toFixed(1) })}
          onChange={reach.setDraftValue}
          onChangeEnd={reach.handleChangeEnd}
        />

        {effectiveGlowFalloff === 'plateau' ? (
          <MarkerMultiplierSlider
            accessibilityLabel={t('mobile.more.boardLook.glowVeil.plateauShare.title')}
            value={plateauShare.draftValue}
            min={BOARD_RENDER_SETTING_BOUNDS.plateauShare.min}
            max={BOARD_RENDER_SETTING_BOUNDS.plateauShare.max}
            step={0.05}
            format={(value) =>
              t('mobile.more.boardLook.glowVeil.plateauShare.value', { value: Math.round(value * 100) })
            }
            onChange={plateauShare.setDraftValue}
            onChangeEnd={plateauShare.handleChangeEnd}
          />
        ) : null}

        <SegmentedControl
          options={veilOptions}
          selectedKey={boardsesh.veil}
          onSelect={(value) => setBoardseshField('veil', value)}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.more.boardLook.glowVeil.veil.title')}
        />

        {boardsesh.veil === 'custom' ? (
          <MarkerMultiplierSlider
            accessibilityLabel={t('mobile.more.boardLook.glowVeil.veilOpacity.title')}
            value={veilOpacity.draftValue}
            min={BOARD_RENDER_SETTING_BOUNDS.veilOpacity.min}
            max={BOARD_RENDER_SETTING_BOUNDS.veilOpacity.max}
            step={0.05}
            format={(value) =>
              t('mobile.more.boardLook.glowVeil.veilOpacity.value', { value: Math.round(value * 100) })
            }
            onChange={veilOpacity.setDraftValue}
            onChangeEnd={veilOpacity.handleChangeEnd}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing[2],
  },
  card: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginHorizontal: spacing[4],
  },
  cardPadded: {
    padding: spacing[3],
    gap: spacing[4],
  },
});
