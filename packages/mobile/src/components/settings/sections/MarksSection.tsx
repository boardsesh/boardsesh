import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SectionHeader } from '../../SectionHeader';
import { SegmentedControl } from '../../SegmentedControl';
import { SwitchRow } from '../../SwitchRow';
import { useTheme } from '../../../providers/theme-provider';
import {
  BOARD_RENDER_SETTING_BOUNDS,
  MARK_STYLE_OPTIONS,
  THUMBNAIL_STYLE_OPTIONS,
  type BoardseshRenderSettings,
  type MarkStyleSetting,
  type ThumbnailStyleSetting,
} from '../../../lib/board-render-settings';
import { borderRadius, spacing } from '../../../theme/tokens';
import { MarkerMultiplierSlider, useCommittedSliderValue } from '../MarkerMultiplierSlider';

type MarksSectionProps = {
  boardsesh: BoardseshRenderSettings;
  setBoardseshField: <Field extends keyof BoardseshRenderSettings>(
    field: Field,
    value: BoardseshRenderSettings[Field],
  ) => void;
};

export function MarksSection({ boardsesh, setBoardseshField }: MarksSectionProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();

  const styleOptions = useMemo<{ key: MarkStyleSetting; label: string }[]>(
    () =>
      MARK_STYLE_OPTIONS.map((option) => ({
        key: option,
        label: t(`mobile.more.boardLook.marks.style.options.${camelCase(option)}`),
      })),
    [t],
  );
  const thumbnailOptions = useMemo<{ key: ThumbnailStyleSetting; label: string }[]>(
    () =>
      THUMBNAIL_STYLE_OPTIONS.map((option) => ({
        key: option,
        label: t(`mobile.more.boardLook.marks.thumbnailStyle.options.${option}`),
      })),
    [t],
  );

  // Hoisted (not inline) so `commit`'s identity is stable across renders —
  // `useCommittedSliderValue`'s `handleChangeEnd` memoizes on `commit`, and an
  // inline arrow here would recreate that memo (and the slider's PanResponder,
  // which depends on `onChangeEnd`) every render for nothing.
  const commitFillOpacity = useCallback(
    (value: number) => setBoardseshField('fillOpacity', value),
    [setBoardseshField],
  );
  const fillOpacity = useCommittedSliderValue(boardsesh.fillOpacity, commitFillOpacity);

  return (
    <View style={styles.section}>
      <SectionHeader title={t('mobile.more.boardLook.marks.title')} />
      <View style={[styles.card, styles.cardPadded, { backgroundColor: systemColors.secondaryBackground }]}>
        <SegmentedControl
          options={styleOptions}
          selectedKey={boardsesh.markStyle}
          onSelect={(value) => setBoardseshField('markStyle', value)}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.more.boardLook.marks.style.title')}
        />

        {boardsesh.markStyle !== 'glow' ? (
          <MarkerMultiplierSlider
            accessibilityLabel={t('mobile.more.boardLook.marks.fillOpacity.title')}
            value={fillOpacity.draftValue}
            min={BOARD_RENDER_SETTING_BOUNDS.fillOpacity.min}
            max={BOARD_RENDER_SETTING_BOUNDS.fillOpacity.max}
            step={0.05}
            format={(value) => t('mobile.more.boardLook.marks.fillOpacity.value', { value: Math.round(value * 100) })}
            onChange={fillOpacity.setDraftValue}
            onChangeEnd={fillOpacity.handleChangeEnd}
          />
        ) : null}

        <SwitchRow
          label={t('mobile.more.boardLook.marks.softDisc.label')}
          description={t('mobile.more.boardLook.marks.softDisc.subtitle')}
          value={boardsesh.softDisc}
          onValueChange={(value) => setBoardseshField('softDisc', value)}
        />
        <SwitchRow
          label={t('mobile.more.boardLook.marks.smallHoldBoost.label')}
          description={t('mobile.more.boardLook.marks.smallHoldBoost.subtitle')}
          value={boardsesh.smallHoldBoost}
          onValueChange={(value) => setBoardseshField('smallHoldBoost', value)}
        />
        <SwitchRow
          label={t('mobile.more.boardLook.marks.ledDots.label')}
          description={t('mobile.more.boardLook.marks.ledDots.subtitle')}
          value={boardsesh.ledDots}
          onValueChange={(value) => setBoardseshField('ledDots', value)}
        />

        <SegmentedControl
          options={thumbnailOptions}
          selectedKey={boardsesh.thumbnailStyle}
          onSelect={(value) => setBoardseshField('thumbnailStyle', value)}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.more.boardLook.marks.thumbnailStyle.title')}
        />
      </View>
    </View>
  );
}

/** `'glow-fill'` -> `'glowFill'`, matching the i18n key naming convention. */
function camelCase(markStyle: MarkStyleSetting): 'glow' | 'glowFill' | 'fill' {
  return markStyle === 'glow-fill' ? 'glowFill' : markStyle;
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
