// Top-level sort chips for the logbook toolbar (the GitHub-PR-view idiom),
// promoting the Latest/Hardest sort out of LogbookFilterSheet so the user can
// switch sort without opening the sheet. Built from native @expo/ui SwiftUI
// controls so the chips are real iOS 26 Liquid Glass capsules. iOS (Liquid
// Glass) only — the Android counterpart is LogbookSortChipRow.android.tsx and
// keeps the sheet's sort control. Mounted on Liquid Glass by the caller; when
// shown, the sheet's own Sort block is suppressed so sort is never worded twice.
//
// Mirrors FilterChipRow.ios.tsx's <Host> / ScrollView / HStack / chipModifiers
// structure, pared down to two mutually-exclusive chips:
//   Latest  → preset 'recent'   (the resting default)
//   Hardest → preset 'hardest'
//
// Each tap commits live through onSelectPreset (the tab's setPreset, which
// persists). Labels reuse the filter sheet's i18n preset keys so a sort is
// never worded two ways.

import { memo, useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Host, HStack, ScrollView, Button } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, tint, padding } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { LogbookSortChipRowProps } from './LogbookSortChipRow.types';

function LogbookSortChipRowComponent({ preset, onSelectPreset }: LogbookSortChipRowProps) {
  const { t } = useTranslation('you');
  const { brandColors } = useTheme();

  // Real iOS 26 Liquid Glass: the inactive chip is a neutral glass capsule
  // (`buttonStyle('glass')`); the active sort is a brand-tinted prominent glass
  // capsule (`buttonStyle('glassProminent')` + tint). @expo/ui guards both with
  // `if #available(iOS 26)`, so they degrade gracefully on older iOS. (Matches
  // FilterChipRow.ios.tsx's chipModifiers.)
  const chipModifiers = useCallback(
    (active: boolean) =>
      active
        ? [buttonStyle('glassProminent'), controlSize('small'), tint(brandColors.primary)]
        : [buttonStyle('glass'), controlSize('small')],
    [brandColors.primary],
  );

  return (
    <Host matchContents={{ vertical: true }} style={styles.host}>
      <ScrollView axes="horizontal" showsIndicators={false}>
        {/* Vertical slack lets a pressed chip's Liquid Glass lens expand without the host's fixed height clipping it. */}
        <HStack spacing={spacing[2]} modifiers={[padding({ horizontal: spacing[4], vertical: spacing[2] })]}>
          <Button
            label={t('mobile.logbook.preset.latest')}
            onPress={() => onSelectPreset('recent')}
            modifiers={chipModifiers(preset === 'recent')}
          />
          <Button
            label={t('mobile.logbook.preset.hardest')}
            onPress={() => onSelectPreset('hardest')}
            modifiers={chipModifiers(preset === 'hardest')}
          />
        </HStack>
      </ScrollView>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});

export const LogbookSortChipRow = memo(LogbookSortChipRowComponent);
