import { getDisplayDescription } from '@boardsesh/shared-schema';
import {
  PLAY_DRAWER_SECTION_IDS,
  type PlayDrawerSectionId,
  type PlayDrawerSectionsVisibility,
} from '../../lib/play-drawer-sections-preference';

/** Eligibility is synchronous so the first enabled header can always mount at the fold. */
export function visiblePlayDrawerSections({
  sections,
  isAuthenticated,
  boardseshGradeEnabled,
  description,
  screenshotMode,
}: {
  sections: PlayDrawerSectionsVisibility;
  isAuthenticated: boolean;
  boardseshGradeEnabled: boolean;
  description: string | null | undefined;
  screenshotMode: boolean;
}): PlayDrawerSectionId[] {
  return PLAY_DRAWER_SECTION_IDS.filter((sectionId) => {
    if (!sections[sectionId]) return false;
    if (sectionId === 'climberLogs') return isAuthenticated && !screenshotMode;
    if (sectionId === 'setterNotes') return Boolean(getDisplayDescription(description));
    if (sectionId === 'boardseshGrade') return boardseshGradeEnabled;
    return true;
  });
}

/**
 * Whether the viewer has switched on a section they could see on some climb.
 * Reads only their saved choices, never the climb (setter notes) or the
 * Boardsesh-grade flag, so the answer holds still while they swipe.
 */
export function hasSwitchedOnPlayDrawerSection({
  sections,
  isAuthenticated,
  screenshotMode,
}: {
  sections: PlayDrawerSectionsVisibility;
  isAuthenticated: boolean;
  screenshotMode: boolean;
}): boolean {
  return PLAY_DRAWER_SECTION_IDS.some((sectionId) => {
    if (!sections[sectionId]) return false;
    if (sectionId === 'climberLogs') return isAuthenticated && !screenshotMode;
    return true;
  });
}
