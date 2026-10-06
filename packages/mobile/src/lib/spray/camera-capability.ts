// Whether THIS BINARY, on THIS device, may open the camera (epic #5346, SW-09).
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
//
// The version gate alone is not enough, because the BINARY can vouch for the
// permission while the DEVICE has no camera to open. expo-image-picker used to
// reject cleanly on the iOS simulator; upstream #45923 (56.0.16, in our 57.x)
// removed that guard, so on a simulator `launchCameraAsync` sets
// `sourceType = .camera` on a picker with no camera source and iOS aborts the
// process — an ObjC exception no JS `catch` can intercept. The hardware check
// therefore belongs before the call, exactly like the permission one.
//
// Only the iOS simulator is excluded. A real iPhone or iPad restricted by Screen
// Time or MDM never reaches the picker: the permission API maps `.restricted` to
// denied, and `pickWallPhotoFromCamera` stops at `denied` with the existing
// toast. Android emulators answer `isDevice === false` too, but there a missing
// camera rejects into the promise (the screen's own catch shows the retry
// toast), and the emulator ships a virtual camera that QA drives — so hiding
// the button there would cost a test path and buy no crash protection.

import * as Application from 'expo-application';
import * as Device from 'expo-device';
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

/**
 * Whether the device behind the binary has a camera the picker can open.
 *
 * `os` and `isDevice` are parameters rather than reads so the rule is testable
 * without a device, and so this module keeps `react-native` off its import
 * graph (the node-env suites cannot parse its entry). `Device.isDevice` is
 * false on the iOS simulator, which has no camera source — launching a camera
 * picker into it aborts the process (#6050). Everywhere else the answer is yes:
 * real iOS devices have a camera or the permission layer already refuses them,
 * and Android's picker fails as a rejection rather than an abort.
 */
export function hasUsableCameraSource(os: string, isDevice: boolean): boolean {
  return os !== 'ios' || isDevice;
}

/**
 * Whether this device, on this binary, can photograph a wall. Constant for the
 * process's life.
 *
 * @param os the `Platform.OS` of the runtime — passed in rather than imported,
 *   see `hasUsableCameraSource`.
 */
export function canPhotographWall(os: string): boolean {
  return supportsWallCamera(Application.nativeApplicationVersion) && hasUsableCameraSource(os, Device.isDevice);
}
