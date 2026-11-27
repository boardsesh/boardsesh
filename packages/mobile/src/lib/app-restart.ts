import { DevSettings } from 'react-native';
import * as Updates from 'expo-updates';

/**
 * Restart the app's JavaScript, for a setting that is read once per launch.
 * Release builds reload through expo-updates (which also applies a downloaded
 * update, the same as any restart). A development build has expo-updates
 * switched off, so `reloadAsync` rejects there and Metro's reload runs instead.
 * Resolves `false` when neither could reload; the setting then applies on the
 * climber's next start, as its footer says.
 */
export async function restartApp(): Promise<boolean> {
  try {
    await Updates.reloadAsync();
    return true;
  } catch {
    if (__DEV__) {
      DevSettings.reload();
      return true;
    }
    return false;
  }
}
