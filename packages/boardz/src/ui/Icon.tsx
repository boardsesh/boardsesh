import type { LucideIcon } from 'lucide-react-native';
import { useTheme } from './theme';

export type IconComponent = LucideIcon;

type IconProps = {
  icon: IconComponent;
  /** 20 by default; 22 in the tab bar, 16 inline. */
  size?: number;
  /** Graphite by default. Icons are never coloured. */
  color?: string;
  strokeWidth?: number;
  /** Fills the glyph, for active states (a starred rating). */
  filled?: boolean;
};

/** A Lucide outline icon at Graphite's 1.75 stroke. */
export function Icon({ icon: Glyph, size = 20, color, strokeWidth = 1.75, filled = false }: IconProps) {
  const theme = useTheme();
  const stroke = color ?? theme.fg2;
  return <Glyph size={size} color={stroke} strokeWidth={strokeWidth} fill={filled ? stroke : 'none'} />;
}
