// Set up's Layout and Size rows (flag `add-board-wizard`): a native menu for a
// short list, a pushed checklist (`/boards/add/setup-option`) for a long one
// (Kilter Homewall has 10 sizes). The checklist hands the pick back through
// this channel, addressed to the form that pushed it (lib/addressed-handoff.ts),
// so a second form mounted under it never takes the pick.

import { createAddressedHandoff } from '../addressed-handoff';

/** A menu holds up to this many options; more go to the pushed checklist. */
export const SETUP_MENU_MAX_OPTIONS = 8;

/** Which control a setup row opens for `optionCount` options. */
export function setupRowControl(optionCount: number): 'menu' | 'list' {
  return optionCount <= SETUP_MENU_MAX_OPTIONS ? 'menu' : 'list';
}

/** The setup fields a row can open the checklist for. */
export type SetupOptionField = 'layout' | 'size';

export type SetupOptionPick = { field: SetupOptionField; value: number };

const setupOptionHandoff = createAddressedHandoff<SetupOptionPick>();

let handoffCounter = 0;

/** A fresh address for one mounted form. */
export function createSetupOptionHandoffId(): string {
  handoffCounter += 1;
  return `setup-option-${handoffCounter}`;
}

export function emitSetupOptionPick(handoffId: string, pick: SetupOptionPick): void {
  setupOptionHandoff.emit(handoffId, pick);
}

/** Listens for the picks handed back to `handoffId` only. Returns the unsubscribe. */
export function subscribeToSetupOptionPicks(handoffId: string, listener: (pick: SetupOptionPick) => void): () => void {
  return setupOptionHandoff.subscribe(handoffId, listener);
}
