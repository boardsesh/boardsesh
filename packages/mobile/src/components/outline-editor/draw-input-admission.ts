import { runOnJS, runOnUI } from 'react-native-reanimated';

/** Earlier completions from this UI runtime reach JS before the publication snapshot is taken. */
export function waitForDrawCallbacks(): Promise<void> {
  return new Promise((resolve) => {
    runOnUI((complete: () => void) => {
      'worklet';
      runOnJS(complete)();
    })(() => resolve());
  });
}
