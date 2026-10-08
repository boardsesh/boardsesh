// The logbook toolbar's persistent facet-chip row, mirroring the climb list's
// FilterChipRow.ios.tsx: a single <Host> wrapping a horizontal SwiftUI ScrollView
// + HStack of native @expo/ui glass chips. iOS-26 Liquid Glass only (the caller
// gates on the glass variant); Android keeps the sheet's filter/sort.
//
// Order: [Latest] [Hardest] [Grade] [Angle] [Show] [Date].
// The full filter sheet opens from the fixed button beside search.
//   Latest / Hardest → live-commit the sort preset.
//   Grade / Angle / Date → toggle a lifted inline rail (LogbookTab renders the
//                          RN rail below this Host; one open at a time).
//   Show     → a native Menu of Toggles (sends / attempts / flash / benchmarks)
//              that stays open (menuActionDismissBehavior) and live-commits.
//
// Every facet is ALWAYS shown — neutral glass with a resting placeholder until
// set, then brand-tint prominent glass with the value (HIG Color: one tint for
// every interactive element, so the logbook no longer uses amber). The
// wording is sourced once in LogbookChipRow.logic.ts so it never diverges from
// the sheet / badge.

import { memo, useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Host, HStack, ScrollView, Menu, Button, Toggle } from '@expo/ui/swift-ui';
import {
  buttonStyle,
  controlSize,
  tint,
  foregroundColor,
  padding,
  menuActionDismissBehavior,
  fixedSize,
} from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing } from '../../theme/tokens';
import { brandAccentColor } from '../../theme/expo-ui-modifiers';
import { buildLogbookFacets } from './LogbookChipRow.logic';
import type { LogbookChipRowProps } from './LogbookChipRow.types';

function LogbookChipRowComponent({
  sortPreset,
  onSelectPreset,
  filters,
  grades,
  onToggleFacet,
  onUpdateFilters,
}: LogbookChipRowProps) {
  const { t } = useTranslation('you');
  const { brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();

  // Active = brand-tinted prominent glass with the on-fill label, inactive =
  // neutral glass. Same tint as every other control (HIG Color). @expo/ui guards
  // the glass styles with `if #available(iOS 26)`.
  const chipModifiers = useCallback(
    (active: boolean) =>
      active
        ? [
            buttonStyle('glassProminent'),
            controlSize('small'),
            tint(brandAccentColor(brandColors)),
            foregroundColor(brandColors.onPrimary),
          ]
        : [buttonStyle('glass'), controlSize('small')],
    [brandColors],
  );

  // Rebuilt only when the filters / grade scale / formatter change, so the facet
  // descriptors keep a stable identity between unrelated re-renders.
  const facets = useMemo(() => buildLogbookFacets(filters, grades, formatGrade, t), [filters, grades, formatGrade, t]);
  const grade = facets[0];
  const angle = facets[1];
  const show = facets[2];
  const date = facets[3];

  // Live-commit handlers for the Show menu's toggles. Sends and Attempts can't
  // both be off (mirrors the sheet's status logic) — turning one off while the
  // other is already off keeps the other on. Flash is a send refinement, so
  // dropping sends from the result set also clears flashOnly.
  const handleToggleSends = useCallback(
    (next: boolean) => {
      if (!next && !filters.includeAttempts) return; // would leave both off — keep sends on.
      onUpdateFilters({ includeSends: next, ...(next ? {} : { flashOnly: false }) });
    },
    [filters.includeAttempts, onUpdateFilters],
  );
  const handleToggleAttempts = useCallback(
    (next: boolean) => {
      if (!next && !filters.includeSends) return; // would leave both off — keep attempts on.
      onUpdateFilters({ includeAttempts: next });
    },
    [filters.includeSends, onUpdateFilters],
  );
  const handleToggleFlash = useCallback((next: boolean) => onUpdateFilters({ flashOnly: next }), [onUpdateFilters]);
  const handleToggleBenchmarks = useCallback(
    (next: boolean) => onUpdateFilters({ benchmarkOnly: next }),
    [onUpdateFilters],
  );

  // Rail-facet taps route through the lifted toggle (close if already open).
  const handleGradeChip = useCallback(() => onToggleFacet('grade'), [onToggleFacet]);
  const handleAngleChip = useCallback(() => onToggleFacet('angle'), [onToggleFacet]);
  const handleDateChip = useCallback(() => onToggleFacet('date'), [onToggleFacet]);

  const handleSelectLatest = useCallback(() => onSelectPreset('recent'), [onSelectPreset]);
  const handleSelectHardest = useCallback(() => onSelectPreset('hardest'), [onSelectPreset]);

  // Flash is a send refinement: when sends leave the result set the toggle reads
  // as off (and committing it is a no-op), matching the sheet.
  const flashOn = filters.flashOnly && filters.includeSends;

  return (
    <Host matchContents={{ vertical: true }} style={styles.host}>
      <ScrollView axes="horizontal" showsIndicators={false}>
        {/* Vertical padding gives a pressed chip's glass lens room to expand.
            `fixedSize(horizontal)` keeps the labels whole: a horizontal ScrollView still proposes its own (screen)
            width to the content, so without it the HStack squeezes every chip toward its minimum and the labels
            truncate mid-word even though the row overflows and scrolls anyway (the same squeeze behind #3782). */}
        <HStack
          spacing={spacing[2]}
          modifiers={[
            padding({ horizontal: spacing[4], vertical: spacing[2] }),
            fixedSize({ horizontal: true, vertical: false }),
          ]}
        >
          {/* Latest / Hardest — live-commit the sort preset; null lights neither. */}
          <Button
            label={t('mobile.logbook.preset.latest')}
            onPress={handleSelectLatest}
            modifiers={chipModifiers(sortPreset === 'recent')}
          />
          <Button
            label={t('mobile.logbook.preset.hardest')}
            onPress={handleSelectHardest}
            modifiers={chipModifiers(sortPreset === 'hardest')}
          />

          {/* Grade / Angle — open the matching inline rail (LogbookTab renders it
              below the Host); brand-tinted once a bound is set. */}
          <Button label={grade.label} onPress={handleGradeChip} modifiers={chipModifiers(grade.active)} />
          <Button label={angle.label} onPress={handleAngleChip} modifiers={chipModifiers(angle.active)} />

          {/* Show ▾ — sends / attempts / flash / benchmarks toggles;
              menuActionDismissBehavior keeps it open so several can flip in one
              pass. Sends/Attempts are guarded so they can't both turn off. */}
          <Menu label={show.label} modifiers={[...chipModifiers(show.active), menuActionDismissBehavior('disabled')]}>
            <Toggle
              label={t('mobile.logbook.status.sends')}
              isOn={filters.includeSends}
              onIsOnChange={handleToggleSends}
            />
            <Toggle
              label={t('mobile.logbook.status.attempts')}
              isOn={filters.includeAttempts}
              onIsOnChange={handleToggleAttempts}
            />
            <Toggle label={t('mobile.logbook.flashOnly')} isOn={flashOn} onIsOnChange={handleToggleFlash} />
            <Toggle
              label={t('mobile.logbook.benchmarksOnly')}
              isOn={filters.benchmarkOnly}
              onIsOnChange={handleToggleBenchmarks}
            />
          </Menu>

          {/* Date → the inline From/To rail; brand-tinted once a bound is set. */}
          <Button label={date.label} onPress={handleDateChip} modifiers={chipModifiers(date.active)} />
        </HStack>
      </ScrollView>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
    // The @expo/ui Host's hosting view otherwise paints a system background;
    // the climbs chip row reads transparent because it sits on the chrome's
    // blur, while this row sits on a plain toolbar — so the system fill shows
    // through as an opaque band. Force transparent so the page shows behind it.
    backgroundColor: 'transparent',
  },
});

// The chips don't take the rail's open-state: each chip tap is a TOGGLE via
// onToggleFacet, and the parent (LogbookTab) owns which rail is open and renders
// it below this Host. Keeping open-state off the props lets this row stay
// memoised across rail toggles.
export const LogbookChipRow = memo(LogbookChipRowComponent);
