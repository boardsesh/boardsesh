import { spacing } from '../../theme/tokens';
import { GRADE_CHIP_HEIGHT } from '../grade/GradeChip';

// The grade rail sits in a fixed-height row of the iOS Filters Form: an RN view
// inside SwiftUI gets no height negotiation that holds up in a scrolling
// container (see MoreForm's `custom` row). The chip labels have no font-size cap,
// so the chips grow with Dynamic Type, and the row has to grow with them or the
// rail is clipped at the larger text sizes.

/** The rail at the default text size: a chip plus the strip's vertical padding. */
const BASE_HEIGHT = GRADE_CHIP_HEIGHT + spacing[1] * 2;
/** How much one step of font scale adds to a chip: about one label line. */
const LABEL_LINE_HEIGHT = 22;

export function gradeRailRowHeight(fontScale: number): number {
  return Math.ceil(BASE_HEIGHT + Math.max(0, fontScale - 1) * LABEL_LINE_HEIGHT);
}
