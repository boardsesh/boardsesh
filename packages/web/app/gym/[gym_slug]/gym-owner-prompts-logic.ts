// Pure selection of which owner-facing setup prompts the public gym page shows.
// Framework-free so the gating matrix (canEdit × content present/absent) is
// unit-testable without rendering. Each prompt maps to a missing piece of the
// gym's public page and deep-links into the matching manage-console tab.

export type OwnerPromptKey = 'boards' | 'hours' | 'description' | 'kiosk' | 'branding';

/** Which manage-console tab each owner prompt deep-links to. */
export const OWNER_PROMPT_TAB: Record<OwnerPromptKey, 'boards' | 'profile' | 'kiosks' | 'branding'> = {
  boards: 'boards',
  hours: 'profile',
  description: 'profile',
  kiosk: 'kiosks',
  branding: 'branding',
};

export type OwnerPromptsInput = {
  /** Only editors get setup prompts — a non-owner viewer sees none. */
  canEdit: boolean;
  /** At least one board is linked to the gym. */
  hasBoards: boolean;
  /** Opening hours are filled in. */
  hasHours: boolean;
  /** A description is filled in. */
  hasDescription: boolean;
  /** A default kiosk exists for the gym. */
  hasKiosk: boolean;
  /** A logo or any brand colour is set. */
  hasBranding: boolean;
};

/**
 * The prompts to show, in display order: link boards, add hours, add a
 * description, put a wall on a TV, add branding. Hours and description come
 * early because they're what a climber deciding whether to visit actually reads.
 * A prompt appears only when its content is missing; a non-editor gets none.
 */
export function ownerPromptsToShow(input: OwnerPromptsInput): OwnerPromptKey[] {
  if (!input.canEdit) {
    return [];
  }
  const prompts: OwnerPromptKey[] = [];
  if (!input.hasBoards) prompts.push('boards');
  if (!input.hasHours) prompts.push('hours');
  if (!input.hasDescription) prompts.push('description');
  if (!input.hasKiosk) prompts.push('kiosk');
  if (!input.hasBranding) prompts.push('branding');
  return prompts;
}
