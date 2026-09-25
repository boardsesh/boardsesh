// Whether THIS BINARY may open the camera (epic #5346, SW-09).
//
// The camera button is the one part of the add-a-wall flow that cannot ship by
// OTA on its own. `launchCameraAsync` needs `NSCameraUsageDescription` in the
// Info.plist and `CAMERA` in the Android manifest, both of which come from the
// `expo-image-picker` plugin config — native inputs, baked into the binary. SW-02
// (#5474, the epic's one native PR) added them and opened the 2.6.0 train; this
// slice rides an OTA into a fleet where some phones have that binary and some
// still run 2.5.x.
//
// Asking the permission API is NOT a substitute. On iOS, requesting camera
// access with no usage description does not resolve to "denied" — it terminates
// the process. The check has to happen before anything touches the camera, and
// it has to describe the BINARY rather than the JS bundle, which rules out
// `Constants.expoConfig` (that is whatever the current OTA update declares, not
// what was compiled).
//
// `expo-application`'s `nativeApplicationVersion` is read from the compiled app
// (CFBundleShortVersionString / versionName), so it is exactly that: a fact
// about the installed binary that no OTA can move.

import * as Application from 'expo-application';
import { isNativeVersionAtLeast } from '../native-version';

/**
 * The first app version whose binary declares the camera permission.
 *
 * Bumping this is how the gate opens. It must name a version that actually
 * SHIPPED with SW-02's `app.config.ts` — getting it wrong in one direction hides
 * the button from phones that could use it, and in the other terminates iOS the
 * first time somebody taps it, so it is compared as a whole version rather than
 * guessed from a build number.
 */
export const FIRST_VERSION_WITH_WALL_CAMERA = '2.6.0';

/**
 * Whether `nativeVersion` is at or past `minimum`.
 *
 * An unreadable version answers false. Every unknown is treated as "too old"
 * because the cost is asymmetric: hiding the button costs a climber one extra
 * tap through the photo library, and showing it on a binary without the usage
 * description crashes the app.
 */
export function supportsWallCamera(
  nativeVersion: string | null | undefined,
  minimum = FIRST_VERSION_WITH_WALL_CAMERA,
): boolean {
  return isNativeVersionAtLeast(nativeVersion, minimum);
}

/** Whether the installed binary can photograph a wall. Constant for the process's life. */
export function canPhotographWall(): boolean {
  return supportsWallCamera(Application.nativeApplicationVersion);
}
