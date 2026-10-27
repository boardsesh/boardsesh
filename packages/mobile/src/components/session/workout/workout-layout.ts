// Layout rules the workout rows share (#6903).

/**
 * From this system font scale a climb line stacks its glyphs and status under
 * the name instead of beside it: beside it, the fixed-width glyphs leave the
 * name a word or two per line. The same step the climb list wraps names at
 * (`climbRowNameLines`).
 */
const STACK_FONT_SCALE = 1.3;

export function workoutRowStacks(fontScale: number): boolean {
  return fontScale >= STACK_FONT_SCALE;
}
