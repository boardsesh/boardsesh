import { isMoonboardBoardName } from '@boardsesh/board-config';
import { getDisplayDescription } from '@boardsesh/shared-schema';
import type { BelowFoldSectionId, PlayDrawerSectionsVisibility } from '../../lib/play-drawer-sections-preference';
import { visibleSectionIds } from '../../lib/section-layout';

/**
 * The below-the-fold sections to draw, in the climber's order. Eligibility is
 * synchronous so the first enabled header can always mount at the fold.
 */
export function visiblePlayDrawerSections({
  sections,
  order,
  isAuthenticated,
  boardseshGradeEnabled,
  description,
  boardName,
  screenshotMode,
}: {
  sections: PlayDrawerSectionsVisibility;
  order: readonly BelowFoldSectionId[];
  isAuthenticated: boolean;
  boardseshGradeEnabled: boolean;
  description: string | null | undefined;
  /** The board the displayed climb is drawn on. */
  boardName: string;
  screenshotMode: boolean;
}): BelowFoldSectionId[] {
  return visibleSectionIds({ order, visible: sections }, (sectionId) => {
    // MoonBoard only: other boards are too dense for a list of holds to help,
    // and a switch left on from a MoonBoard session never shows it on them.
    if (sectionId === 'activeHolds') return isMoonboardBoardName(boardName);
    if (sectionId === 'climberLogs') return isAuthenticated && !screenshotMode;
    if (sectionId === 'setterNotes') return Boolean(getDisplayDescription(description));
    if (sectionId === 'boardseshGrade') return boardseshGradeEnabled;
    return true;
  });
}
