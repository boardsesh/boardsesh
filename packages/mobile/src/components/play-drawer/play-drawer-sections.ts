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
  screenshotMode,
}: {
  sections: PlayDrawerSectionsVisibility;
  order: readonly BelowFoldSectionId[];
  isAuthenticated: boolean;
  boardseshGradeEnabled: boolean;
  description: string | null | undefined;
  screenshotMode: boolean;
}): BelowFoldSectionId[] {
  return visibleSectionIds({ order, visible: sections }, (sectionId) => {
    if (sectionId === 'climberLogs') return isAuthenticated && !screenshotMode;
    if (sectionId === 'setterNotes') return Boolean(getDisplayDescription(description));
    if (sectionId === 'boardseshGrade') return boardseshGradeEnabled;
    return true;
  });
}
