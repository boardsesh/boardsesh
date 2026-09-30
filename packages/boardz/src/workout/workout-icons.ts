import type { IconComponent } from '../ui/Icon';
import { ChartColumn, Clock, Crosshair, Flame, Grid2x2, Mountain, Timer, TrendingUp, Triangle } from '../ui/icons';
import type { WorkoutKind } from './catalog';

/** Each workout's glyph, kept out of the catalogue so it stays plain data. */
export const WORKOUT_ICONS: Record<WorkoutKind, IconComponent> = {
  warmUp: Flame,
  pyramid: Triangle,
  ladder: TrendingUp,
  volume: ChartColumn,
  gradeFocus: Crosshair,
  onTheMinute: Timer,
  fourByFour: Grid2x2,
  limitBouldering: Mountain,
  freeClimbing: Clock,
};
