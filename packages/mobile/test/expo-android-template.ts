/**
 * The shape of `android/app/build.gradle` that Expo SDK 57's prebuild template
 * generates, trimmed to the parts our config plugins transform or assert on.
 *
 * Shared by the `with-android-release-signing` and `with-android-minify` suites
 * so template drift is a one-place edit. That matters more than it sounds:
 * `with-android-minify` exists to guarantee the release build is minified, and
 * its guard tests are only meaningful if this fixture is TRUTHFUL. An earlier
 * copy of it in the signing suite still carried the SDK 56 spelling
 * (`minifyEnabled enableProguardInReleaseBuilds`), which would have made the
 * minify guard's "throws when the property is renamed" test pass against a
 * template that never existed on SDK 57.
 *
 * Verified against the output of `expo prebuild --platform android` on Expo
 * 57.0.18 / React Native 0.86.3. Two details are load-bearing:
 *   - both build types carry an identical `signingConfig signingConfigs.debug`
 *     line, which is the ambiguity the signing transform has to resolve;
 *   - `debug {` precedes `release {` inside `buildTypes`, which is what makes
 *     the minify guard's release-block anchoring testable.
 */
export const SAMPLE_APP_BUILD_GRADLE = `apply plugin: "com.android.application"
apply plugin: "org.jetbrains.kotlin.android"
apply plugin: "com.facebook.react"

/**
 * Set this to true to Run Proguard on Release builds to minify the Java bytecode.
 */
def enableMinifyInReleaseBuilds = (findProperty('android.enableMinifyInReleaseBuilds') ?: false).toBoolean()

android {
    ndkVersion rootProject.ext.ndkVersion

    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
            minifyEnabled enableMinifyInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
            def enablePngCrunchInRelease = findProperty('android.enablePngCrunchInReleaseBuilds') ?: 'true'
            crunchPngs enablePngCrunchInRelease.toBoolean()
        }
    }
}`;

/**
 * The `android/app/proguard-rules.pro` the same template writes: a header
 * comment plus the reanimated / turbomodule keeps it hardcodes. Inert today
 * (minifyEnabled was false), load-bearing the moment R8 runs — which is why the
 * minify suite asserts these survive the keep-rule append.
 */
export const SAMPLE_PROGUARD_RULES = `# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:
`;
