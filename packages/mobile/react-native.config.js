/**
 * React Native autolinking overrides for this app.
 *
 * ONLY reason this file exists: `onnxruntime-react-native` (epic #5346, SW-02)
 * ships a legacy `unimodule.json` next to its `android/build.gradle`. Expo's
 * autolinking treats any package carrying an Expo module config as an Expo
 * module, and `resolveDependencyConfigImplAndroidAsync` in
 * `expo-modules-autolinking` returns `null` for a package that has BOTH an Expo
 * module config and a plain Gradle project, on the grounds that linking it twice
 * would conflict:
 *
 *     if (reactNativeConfig === undefined && expoModuleConfig?.supportsPlatform('android')) {
 *       if (!!gradle && !expoModuleConfig?.rawConfig.android?.gradlePath) return null;
 *     }
 *
 * `unimodule.json` is the pre-SDK-45 config format, so nothing actually links it
 * as an Expo module — the package silently disappears from the Android build and
 * `NativeModules.Onnxruntime` is null at runtime. This is upstream ONNX Runtime
 * issue #29005, whose fix has been open since 2026-06-11.
 *
 * Declaring the android platform here makes `reactNativeConfig` defined rather
 * than `undefined`, which skips that guard and links the package as the ordinary
 * React Native module it is. Verified with
 * `vp exec expo-modules-autolinking react-native-config --platform android`.
 *
 * iOS needs nothing: the same resolver links the podspec already (the guard is
 * Android-only), which is also why the package's own `app.plugin.js` is NOT
 * registered in app.config.ts — its Podfile mod would declare a pod CocoaPods
 * already has from autolinking.
 */
module.exports = {
  dependencies: {
    'onnxruntime-react-native': {
      platforms: {
        android: {},
      },
    },
  },
};
