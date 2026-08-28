import { describe, it, expect } from 'vite-plus/test';
import { ownerPromptsToShow, OWNER_PROMPT_TAB } from '../gym-owner-prompts-logic';

const FULLY_SET_UP = {
  canEdit: true,
  hasBoards: true,
  hasHours: true,
  hasDescription: true,
  hasKiosk: true,
  hasBranding: true,
};

const NOTHING_SET_UP = {
  canEdit: true,
  hasBoards: false,
  hasHours: false,
  hasDescription: false,
  hasKiosk: false,
  hasBranding: false,
};

describe('ownerPromptsToShow', () => {
  it('shows nothing to a non-editor, regardless of content', () => {
    expect(ownerPromptsToShow({ ...NOTHING_SET_UP, canEdit: false })).toEqual([]);
    expect(ownerPromptsToShow({ ...FULLY_SET_UP, canEdit: false })).toEqual([]);
  });

  it('shows every prompt, in order, to an editor whose gym has nothing filled in', () => {
    expect(ownerPromptsToShow(NOTHING_SET_UP)).toEqual(['boards', 'hours', 'description', 'kiosk', 'branding']);
  });

  it('shows nothing to an editor whose gym is fully set up', () => {
    expect(ownerPromptsToShow(FULLY_SET_UP)).toEqual([]);
  });

  it('shows only the prompts for the missing pieces', () => {
    expect(ownerPromptsToShow({ ...FULLY_SET_UP, hasKiosk: false })).toEqual(['kiosk']);
    expect(ownerPromptsToShow({ ...FULLY_SET_UP, hasHours: false })).toEqual(['hours']);
    expect(ownerPromptsToShow({ ...FULLY_SET_UP, hasBoards: false, hasBranding: false })).toEqual([
      'boards',
      'branding',
    ]);
    expect(ownerPromptsToShow({ ...FULLY_SET_UP, hasHours: false, hasDescription: false })).toEqual([
      'hours',
      'description',
    ]);
  });
});

describe('OWNER_PROMPT_TAB', () => {
  it('sends the hours and description prompts to the profile tab that edits them', () => {
    expect(OWNER_PROMPT_TAB.hours).toBe('profile');
    expect(OWNER_PROMPT_TAB.description).toBe('profile');
  });

  it('leaves the existing prompts on their own tabs', () => {
    expect(OWNER_PROMPT_TAB.boards).toBe('boards');
    expect(OWNER_PROMPT_TAB.kiosk).toBe('kiosks');
    expect(OWNER_PROMPT_TAB.branding).toBe('branding');
  });
});
