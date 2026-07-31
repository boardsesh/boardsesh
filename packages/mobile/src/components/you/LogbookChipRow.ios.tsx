// The logbook toolbar's persistent facet-chip row, mirroring the climb list's
// FilterChipRow.ios.tsx: a single <Host> wrapping a horizontal SwiftUI ScrollView
// + HStack of native @expo/ui glass chips. iOS-26 Liquid Glass only (the caller
// gates on the glass variant); Android keeps the sheet's filter/sort.
//
// Order: [Filter] [Latest] [Hardest] [Grade] [Angle] [Show] [Date].
//   Filter   → opens the long-tail sheet (full set / less-common controls).
//   Latest / Hardest → live-commit the sort preset.
//   Grade / Angle / Date → toggle a lifted inline rail (LogbookTab renders the
//                          RN rail below this Host; one open at a time).
//   Show     → a native Menu of Toggles (sends / attempts / flash / benchmarks)
//              that stays open (menuActionDismissBehavior) and live-commits.
//
// Every facet is ALWAYS shown — neutral glass with a resting placeholder until
// set, then amber prominent glass with the value. Amber (brandColors.accent, not
// the climb search's purple) marks this as the logbook, not a live search. The
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
  labelStyle,
  accessibilityLabel,
} from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { anyFilterActive, buildLogbookFacets } from './LogbookChipRow.logic';
import type { LogbookChipRowProps } from './LogbookChipRow.types';

function LogbookChipRowComponent({
  sortPreset,
  onSelectPreset,
  onOpenFilters,
  filters,
  grades,
  onToggleFacet,
  onUpdateFilters,
}: LogbookChipRowProps) {
  const { t } = useTranslation('you');
  const { brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();

  // Active = amber-tinted prominent glass with dark text, inactive = neutral glass.
  // Amber (brandColors.accent) instead of the climb search's purple so the logbook
  // reads as the logbook; amber is fill-only and pairs with dark text per
  // brandColors, so the prominent chips force a black label. @expo/ui guards the
  // glass styles with `if #available(iOS 26)`.
  const chipModifiers = useCallback(
    (active: boolean) =>
      active
        ? [
            buttonStyle('glassProminent'),
            controlSize('small'),
            tint(brandColors.accent),
            foregroundColor(iosSystemColors.black),
          ]
        : [buttonStyle('glass'), controlSize('small')],
    [brandColors.accent],
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

  // The Filter chip is icon-only. `SwiftUI.Button(title, systemImage:)` builds a
  // `Label`, and inside the glass HStack the icon+one-word title combination made
  // SwiftUI compress the title to "F…" (#3782) — the plain-text chips beside it are
  // fine. `labelStyle(.iconOnly)` drops the title from layout so the chip sizes to
  // the symbol alone, matching the round icon-only filter button the Android
  // (Material) logbook toolbar already ships. The title still has to be passed —
  // @expo/ui only renders `systemImage` when a `label` is present — and iconOnly
  // keeps it as the VoiceOver name; `accessibilityLabel` states that explicitly so
  // the affordance can't silently lose its name.
  const filterLabel = t('mobile.logbook.filter');
  const filterModifiers = useMemo(
    () => [...chipModifiers(anyFilterActive(facets)), labelStyle('iconOnly'), accessibilityLabel(filterLabel)],
    [chipModifiers, facets, filterLabel],
  );

  const handleSelectLatest = useCallback(() => onSelectPreset('recent'), [onSelectPreset]);
  const handleSelectHardest = useCallback(() => onSelectPreset('hardest'), [onSelectPreset]);

  // Flash is a send refinement: when sends leave the result set the toggle reads
  // as off (and committing it is a no-op), matching the sheet.
  const flashOn = filters.flashOnly && filters.includeSends;

  return (
    <Host matchContents={{ vertical: true }} style={styles.host}>
      <ScrollView axes="horizontal" showsIndicators={false}>
        {/* Vertical padding gives a pressed chip's glass lens room to expand. */}
        <HStack spacing={spacing[2]} modifiers={[padding({ horizontal: spacing[4], vertical: spacing[2] })]}>
          {/* Filter → the long-tail sheet. An action button, not a menu, and
              icon-only (see filterModifiers). Neutral glass until at least one
              facet is active, then amber — matching the climb search, where Filters
              only colours up once filters are set. The sort (Latest/Hardest)
              doesn't count, so it never tints the Filter chip. */}
          <Button
            label={filterLabel}
            systemImage="line.3.horizontal.decrease"
            onPress={onOpenFilters}
            modifiers={filterModifiers}
          />

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
              below the Host); amber once a bound is set. */}
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

          {/* Date → the inline From/To rail; amber once a bound is set. */}
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
