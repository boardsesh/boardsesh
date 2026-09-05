import { describe, it, expect, vi } from 'vitest';

// StyleSheet.create is identity here, so the assertions below read the numbers
// that actually ship. Platform/PlatformColor come in transitively via the theme.
vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({ Text: 'Text' }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {}, brandColors: {} }) }));

// The style object, read straight off the module. StyleSheet.create is identity
// in this environment, so these are the numbers that actually ship.
import { statusRowStyles, RESERVED_LINE_HEIGHT } from '../CreateDraftStatusRow';

/**
 * Two numbers on this row are load-bearing well beyond the row itself.
 *
 * The drawer derives its peek snap-point from the MEASURED above-fold height,
 * and this row sits inside that measured block. Its whole promise is that it
 * occupies the same box whether or not it has anything to say — otherwise the
 * first painted hold changes the row's height, moves `peekHeight`, and
 * re-snaps a sheet the climber had expanded.
 *
 * That promise was quietly broken: Yoga measures `minHeight` against the border
 * box, so a floor equal to the bare line height was already met by the row's own
 * padding, and the row stood 16dp empty against 32dp full. The reset-zoom
 * control now parks in that box too, so a short row also drops the control onto
 * the Save button above it.
 */
describe('CreateDraftStatusRow reserved box', () => {
  it('floors the row at padding + line, so it is the same height empty as full', () => {
    const { paddingTop, paddingBottom, minHeight } = statusRowStyles.row;
    // The height an occupied row lays out to: content plus its own padding.
    const occupied = RESERVED_LINE_HEIGHT + paddingTop + paddingBottom;
    expect(minHeight).toBe(occupied);
  });
});
