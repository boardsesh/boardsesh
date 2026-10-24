import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { isThemeOverride, isUiVariantPreference } from '@boardsesh/key-value-storage';
import { useTheme } from '../../providers/theme-provider';

/**
 * Apply a focused story's appearance to the whole app and persist it, like
 * Settings. Stack routes can stay mounted on blur; they must stop reapplying
 * their own params when another story changes these shared preferences.
 */
export function useStoryAppearance(themeParam: string | undefined, variantParam: string | undefined): void {
  const { themeOverride, setThemeOverride, uiVariantPreference, setUiVariant } = useTheme();
  useFocusEffect(
    useCallback(() => {
      if (isThemeOverride(themeParam) && themeParam !== themeOverride) void setThemeOverride(themeParam);
      if (isUiVariantPreference(variantParam) && variantParam !== uiVariantPreference) void setUiVariant(variantParam);
    }, [themeParam, themeOverride, setThemeOverride, variantParam, uiVariantPreference, setUiVariant]),
  );
}
