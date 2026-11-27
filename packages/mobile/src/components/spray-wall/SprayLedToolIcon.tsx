import type { ColorValue } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '../../providers/theme-provider';
import { SPRAY_CABLE_COLOR } from './SpraySetupOverlay';

export type SprayLedToolIconName = 'next-unmapped-hold' | 'next-free-led' | 'select-two-leds' | 'insert-skipped-leds';

export function SprayLedToolIcon({ name, color }: { name: SprayLedToolIconName; color: ColorValue }) {
  const { brandColors } = useTheme();
  if (name === 'insert-skipped-leds') {
    return (
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" strokeWidth={1.5}>
        <Path d="M5.5 12h2M16.5 12h2" stroke={SPRAY_CABLE_COLOR} strokeLinecap="round" />
        <Circle cx={3.25} cy={12} r={2.25} stroke={brandColors.primary} />
        <Circle cx={20.75} cy={12} r={2.25} stroke={brandColors.primary} />
        <Path d="M9.5 12h5M12 9.5v5" stroke={brandColors.error} strokeLinecap="round" />
      </Svg>
    );
  }
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" strokeWidth={1.5}>
      {name === 'select-two-leds' ? (
        <>
          <Circle cx={5} cy={4} r={2} stroke={color} />
          <Circle cx={17.5} cy={4} r={2} stroke={color} />
          <Path
            d="M9 22l-4.5-6a1.45 1.45 0 0 1 2.2-1.9l2.1 2V7.3a1.5 1.5 0 0 1 3 0V11c1.2-1.2 2.9-.5 3.1.9 1.2-.9 2.7-.3 3 1 1.5-.6 2.9.4 2.8 1.9-.2 2.9-.8 5.5-2.5 7.2Z"
            stroke={color}
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          {name === 'next-unmapped-hold' ? (
            <>
              <Path
                d="M2 12.5c0-3 4.4-7.4 7-6.7 2.7.9 6.5.3 6.8 3.6.2 2.7-2.4 5.3-5.7 7.7C7.1 19.2 2 16.6 2 12.5Z"
                stroke={brandColors.error}
                strokeDasharray="2.2 1.9"
              />
              <Circle cx={9} cy={12} r={1} fill={color} />
            </>
          ) : (
            <>
              <Circle cx={9} cy={12} r={5.5} stroke={brandColors.error} strokeDasharray="2.2 1.9" />
              <Circle cx={9} cy={12} r={1.55} fill={brandColors.primary} />
            </>
          )}
          <Path d="m19 9 3 3-3 3" stroke={color} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </Svg>
  );
}
