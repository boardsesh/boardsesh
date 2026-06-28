// Latest/Hardest sort as native @expo/ui SwiftUI glass chips, mirroring the
// climb list's FilterChipRow.ios.tsx. iOS-26 Liquid Glass only; the caller
// suppresses the sheet's Sort block while these show.

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

  // Active = brand-tinted prominent glass, inactive = neutral glass; @expo/ui
  // guards both with `if #available(iOS 26)`. Matches FilterChipRow's chipModifiers.
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
        {/* Vertical padding gives a pressed chip's glass lens room to expand. */}
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
