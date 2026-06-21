// Decoupled window event for the board-presence "Switch board" control.
//
// The board sheet's separated "Switch board" footer dispatches this; the bottom
// tab bar (which already owns the board-selector drawer + boardConfigs) listens
// and opens the existing board switcher. Same indirection pattern as
// SESH_SETTINGS_DRAWER_EVENT, so the sheet stays free of board-config plumbing.
export const BOARD_PRESENCE_SWITCH_BOARD_EVENT = 'boardsesh:boardPresenceSwitchBoard';
