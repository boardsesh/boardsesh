import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../Icon';
import { SectionHeader } from '../../SectionHeader';
import { SegmentedControl } from '../../SegmentedControl';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { applyBoardRenderPreset, matchingPresetId, BOARD_RENDER_PRESETS } from '../../../lib/board-render-presets';
import {
  requestedBoardRenderMode,
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

  const requestedMode = requestedBoardRenderMode(settings, undefined);
  const showRendererUnavailableBanner = boardseshRendererAvailable === false && requestedMode === 'boardsesh';
  const activePresetId = matchingPresetId(settings);

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

      {effectiveMode === 'boardsesh' ? (
        <View style={styles.presetsSection}>
          <SectionHeader title={t('mobile.more.boardLook.presets.title')} />
          <View style={styles.presetRow}>
            {BOARD_RENDER_PRESETS.map((preset) => {
              const selected = activePresetId === preset.id;
              return (
                <Pressable
                  key={preset.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => void applyBoardRenderPreset(preset.id)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: selected ? systemColors.accent : systemColors.fill,
                      borderColor: selected ? systemColors.accent : systemColors.separator,
                    },
                  ]}
                >
                  <Text variant="footnote" color={selected ? systemColors.background : systemColors.label}>
                    {t(preset.labelI18nKey)}
                  </Text>
                </Pressable>
              );
            })}
            <View
              accessibilityLabel={t('mobile.more.boardLook.presets.custom')}
              style={[
                styles.chip,
                styles.customChip,
                {
                  backgroundColor: activePresetId === 'custom' ? systemColors.accent : 'transparent',
                  borderColor: systemColors.separator,
                },
              ]}
            >
              <Text
                variant="footnote"
                color={activePresetId === 'custom' ? systemColors.background : systemColors.secondaryLabel}
              >
                {t('mobile.more.boardLook.presets.custom')}
              </Text>
            </View>
          </View>
        </View>
      ) : null}
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
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  customChip: {
    borderStyle: 'dashed',
  },
});
