import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../Icon';
import { SectionHeader } from '../../SectionHeader';
import { SegmentedControl } from '../../SegmentedControl';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { BoardLookCarousel } from '../../board-look/BoardLookCarousel';
import { useBoardPreviewClimb } from '../../../hooks/use-board-preview-climb';
import { useBoardRenderFlags } from '../../../hooks/use-native-climb-render';
import { trackBoardLookApplied } from '../../../lib/board-render/board-look-analytics';
import { mergePresetPreservingAccessibility } from '../../../lib/board-render-presets';
import {
  BOARD_LOOK_SETTINGS_OPTIONS,
  applyBoardLookOption,
  matchingBoardLookOptionId,
  type BoardLookOptionId,
} from '../../../lib/board-render/board-look-options';
import {
  requestedBoardRenderMode,
  resolveEffectiveRenderSettings,
  type BoardRenderModeSetting,
  type BoardRenderSettings,
} from '../../../lib/board-render-settings';
import { borderRadius, spacing } from '../../../theme/tokens';

type ModeAndPresetsSectionProps = {
  settings: BoardRenderSettings;
  setMode: (mode: BoardRenderModeSetting) => void;
  /** The mode the current settings actually resolve to right now — for the
   *  "Automatic: currently…" caption. */
  effectiveMode: 'classic' | 'boardsesh';
  /** `null` = the capability probe hasn't answered yet; `false` = the installed
   *  binary can't draw the Boardsesh mode at all. */
  boardseshRendererAvailable: boolean | null;
};

const BOARDSESH_DISABLED_KEYS = new Set<BoardRenderModeSetting>(['boardsesh']);

export function ModeAndPresetsSection({
  settings,
  setMode,
  effectiveMode,
  boardseshRendererAvailable,
}: ModeAndPresetsSectionProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();

  const modeOptions = useMemo<{ key: BoardRenderModeSetting; label: string }[]>(
    () => [
      { key: 'default', label: t('mobile.more.boardLook.mode.options.automatic') },
      { key: 'classic', label: t('mobile.more.boardLook.mode.options.classic') },
      { key: 'boardsesh', label: t('mobile.more.boardLook.mode.options.boardsesh') },
    ],
    [t],
  );

  const requestedMode = requestedBoardRenderMode(settings);
  const showRendererUnavailableBanner = boardseshRendererAvailable === false && requestedMode === 'boardsesh';
  const activeOptionId = matchingBoardLookOptionId(settings);
  const { preview } = useBoardPreviewClimb();

  // An installed library that can't draw the Boardsesh mode makes every
  // Boardsesh card a lie; the banner above already explains why, so the
  // carousel collapses to the looks this build can actually render.
  const options = useMemo(
    () =>
      boardseshRendererAvailable === false
        ? BOARD_LOOK_SETTINGS_OPTIONS.filter((option) => !option.requiresBoardseshRenderer)
        : BOARD_LOOK_SETTINGS_OPTIONS,
    [boardseshRendererAvailable],
  );

  const flags = useBoardRenderFlags();
  const handleSelectOption = useCallback(
    (id: BoardLookOptionId) => {
      void applyBoardLookOption(id);
      if (!preview) return;
      // Report the settings the choice PRODUCES, not the ones it replaced: the
      // shared contract reads this event as "the common props now carry this
      // preset_id". Resolved here rather than from the store because the write
      // above is async and the store has not caught up yet.
      const applied =
        id === 'classic'
          ? { ...settings, mode: 'classic' as const }
          : mergePresetPreservingAccessibility(
              BOARD_LOOK_SETTINGS_OPTIONS.find((option) => option.id === id)?.previewSettings ?? settings,
              settings,
            );
      trackBoardLookApplied(
        id,
        resolveEffectiveRenderSettings(applied, flags, boardseshRendererAvailable === true),
        { boardName: preview.boardName, layoutId: preview.layoutId, sizeId: preview.sizeId },
        'settings',
      );
    },
    [boardseshRendererAvailable, flags, preview, settings],
  );

  return (
    <View style={styles.section}>
      {showRendererUnavailableBanner ? (
        <View style={[styles.banner, { backgroundColor: systemColors.secondaryBackground }]}>
          <Icon name="info" size={20} color={systemColors.secondaryLabel} />
          <View style={styles.bannerText}>
            <Text variant="subheadline">{t('mobile.more.boardLook.rendererUnavailable.title')}</Text>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.description}>
              {t('mobile.more.boardLook.rendererUnavailable.body')}
            </Text>
          </View>
        </View>
      ) : null}

      {preview ? (
        <View style={styles.presetsSection}>
          <SectionHeader title={t('mobile.more.boardLook.presets.title')} />
          <BoardLookCarousel
            options={options}
            selectedId={activeOptionId}
            onSelect={handleSelectOption}
            preview={preview}
            boardseshRendererAvailable={boardseshRendererAvailable}
          />
        </View>
      ) : null}

      <SectionHeader title={t('mobile.more.boardLook.mode.title')} />
      <View style={[styles.card, styles.cardPadded, { backgroundColor: systemColors.secondaryBackground }]}>
        <SegmentedControl
          options={modeOptions}
          selectedKey={settings.mode}
          onSelect={setMode}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.more.boardLook.mode.title')}
          disabledKeys={boardseshRendererAvailable === false ? BOARDSESH_DISABLED_KEYS : undefined}
        />
        {settings.mode === 'default' ? (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {effectiveMode === 'boardsesh'
              ? t('mobile.more.boardLook.mode.captionAutomaticBoardsesh')
              : t('mobile.more.boardLook.mode.captionAutomaticClassic')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing[2],
  },
  banner: {
    flexDirection: 'row',
    gap: spacing[3],
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
    padding: spacing[3],
  },
  bannerText: {
    flex: 1,
    gap: spacing[1],
  },
  description: {
    lineHeight: 18,
  },
  card: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginHorizontal: spacing[4],
  },
  cardPadded: {
    padding: spacing[3],
    gap: spacing[3],
  },
  presetsSection: {
    gap: spacing[2],
  },
});
