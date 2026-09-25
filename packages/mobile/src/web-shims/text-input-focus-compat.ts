type WebTextInputState = {
  currentlyFocusedField: () => unknown;
  currentlyFocusedInput?: () => unknown;
};

// React Native Web still names this API currentlyFocusedField. Gorhom and
// Expo Router call the React Native name when a text input loses focus.
export function installWebTextInputFocusCompat(state: WebTextInputState): void {
  state.currentlyFocusedInput ??= () => state.currentlyFocusedField();
}
