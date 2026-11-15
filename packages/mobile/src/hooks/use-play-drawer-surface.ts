import { Platform } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { blendOpaque, playDrawerMaterialTint } from '../theme/colors';
import { iosDarkColors, iosLightColors } from '../theme/ios-colors';
import { useEffectiveSurfaceMode } from './use-effective-surface-mode';

/** The player's background props and the same opaque color for board-art pixels. */
export function usePlayDrawerSurface() {
  const { systemColors, colorScheme, variant, m3SurfaceContainers } = useTheme();
  const mode = useEffectiveSurfaceMode();
  const tintColor = playDrawerMaterialTint[variant][colorScheme];
  // PlatformColor is opaque to JS. Use the existing numeric iOS mirror, not
  // chartColors/sheetSurface, whose Liquid Glass palette is Android's fallback.
  const secondaryBackground =
    Platform.OS === 'ios' && variant === 'liquidGlass'
      ? (colorScheme === 'dark' ? iosDarkColors : iosLightColors).secondaryBackground
      : String(systemColors.secondaryBackground);
  const baseColor = mode === 'material' ? m3SurfaceContainers.low : secondaryBackground;
  // ScreenBackground ignores tint for glass/blur. GlassSurface's other paths
  // composite the route's tint over an opaque low (Material) or secondary base.
  const tinted = mode === 'material' || mode === 'solid';
  const channels = tintColor.match(/[\d.]+/g)!.map(Number);
  const tintHex = `#${channels
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
  const fieldColor = tinted ? blendOpaque(tintHex, baseColor, channels[3]) : baseColor;
  return {
    backgroundProps: {
      color: systemColors.secondaryBackground,
      role: 'low' as const,
      fallbackColor: systemColors.secondaryBackground,
      tintColor,
    },
    fieldColor,
  };
}
