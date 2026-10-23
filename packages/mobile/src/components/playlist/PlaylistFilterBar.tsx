import { memo, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { FilterChipRow } from '../search/FilterChipRow';
import { FilterTokenRow } from '../search/FilterTokenRow';
import type { FilterChipRowProps } from '../search/FilterChipRow.types';
import type { FilterToken } from '../../lib/filter-tokens';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

/** "12 of 117 climbs · Clear filters", while the rows on screen are filtered. */
export type PlaylistFilterStatus = {
  shown: number;
  total: number;
  onClear: () => void;
};

type PlaylistFilterBarProps = {
  chipRowProps: FilterChipRowProps;
  tokens: FilterToken[];
  /** The inline grade rail while the Grade chip has it open. */
  gradeRail: ReactElement | null;
  status: PlaylistFilterStatus | null;
  /** Edit mode: the row greys out, ignores taps and explains why the order is plain. */
  editing: boolean;
};

/**
 * The playlist's filter chrome, under the hero in the list header: the chip row
 * (the Climbs capsule row with the playlist's own pins and sorts), the grade
 * rail, the removable tokens, then a status line or the edit-mode note.
 *
 * Memoised, and every prop arrives memoised (`useClimbFilterSession`), so a page
 * load or the hero collapsing does not re-render the native chip host.
 */
export const PlaylistFilterBar = memo(function PlaylistFilterBar({
  chipRowProps,
  tokens,
  gradeRail,
  status,
  editing,
}: PlaylistFilterBarProps) {
  const { t } = useTranslation('playlists');
  const { systemColors, brandColors, opacity } = useTheme();

  return (
    <View style={styles.container}>
      {/* Reserves the row's height: the native capsule host measures itself a
          frame after mount, and the list header would jump under it. */}
      <View
        style={[styles.chipRow, editing ? { opacity: opacity.disabled } : null]}
        pointerEvents={editing ? 'none' : 'auto'}
        accessibilityElementsHidden={editing}
        importantForAccessibility={editing ? 'no-hide-descendants' : 'auto'}
      >
        <FilterChipRow {...chipRowProps} />
      </View>
      {!editing && gradeRail ? <View style={styles.gradeRail}>{gradeRail}</View> : null}
      {!editing ? <FilterTokenRow tokens={tokens} /> : null}
      {editing ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.statusLine}>
          {t('detail.view.editNote')}
        </Text>
      ) : status ? (
        <View style={[styles.statusLine, styles.statusRow]}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('detail.view.status', { shown: status.shown, count: status.total })}
          </Text>
          <PressableSurface onPress={status.onClear} accessibilityRole="button" hitSlop={8}>
            <Text variant="footnote" color={brandColors.primary} style={styles.clearLabel}>
              {t('detail.view.clearFilters')}
            </Text>
          </PressableSurface>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing[2],
  },
  chipRow: {
    // One small capsule (about 32 pt on iOS, a 32 dp Material chip) plus the
    // row's 8 pt padding above and below.
    minHeight: spacing[8] + spacing[2] * 2,
    justifyContent: 'center',
  },
  gradeRail: {
    paddingBottom: spacing[1],
  },
  statusLine: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing[3],
  },
  clearLabel: {
    fontWeight: '600',
  },
});
