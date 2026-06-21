import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type AndroidReleaseSigningPlugin = {
  applyAndroidReleaseSigning(contents: string): string;
  MARKER: string;
  RELEASE_SIGNING_CONFIG_LINE: string;
};

const plugin = require('../../../plugins/with-android-release-signing.js') as AndroidReleaseSigningPlugin;

// Trimmed shape of the android/app/build.gradle Expo generates: a single
// `debug` signing config and a release build type signed with the debug key.
// Both build types carry an identical `signingConfig signingConfigs.debug`
// line, which is exactly the ambiguity the transform has to resolve.
const SAMPLE_BUILD_GRADLE = `android {
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
            signingConfig signingConfigs.debug
            shrinkResources (findProperty('android.enableShrinkResourcesInReleaseBuilds')?.toBoolean() ?: false)
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
}`;

describe('with-android-release-signing', () => {
  it('injects a release signing config that reads the keystore from env', () => {
    const result = plugin.applyAndroidReleaseSigning(SAMPLE_BUILD_GRADLE);

    expect(result).toContain('storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))');
    expect(result).toContain('storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")');
    expect(result).toContain('keyAlias System.getenv("ANDROID_KEY_ALIAS")');
    expect(result).toContain('keyPassword System.getenv("ANDROID_KEY_PASSWORD")');
  });

  it('points the release build type at the conditional signing config', () => {
    const result = plugin.applyAndroidReleaseSigning(SAMPLE_BUILD_GRADLE);

    expect(result).toContain(plugin.RELEASE_SIGNING_CONFIG_LINE);
  });

  it('leaves the debug build type signed with the debug key', () => {
    const result = plugin.applyAndroidReleaseSigning(SAMPLE_BUILD_GRADLE);

    // The debug build type keeps the plain debug-key line; only the release one
    // is rewritten to the env-conditional ternary.
    const debugBlock = result.slice(result.indexOf('debug {', result.indexOf('buildTypes')));
    expect(debugBlock).toMatch(/debug\s*\{\s*signingConfig signingConfigs\.debug/);
  });

  it('is idempotent — a second pass is a no-op', () => {
    const once = plugin.applyAndroidReleaseSigning(SAMPLE_BUILD_GRADLE);
    const twice = plugin.applyAndroidReleaseSigning(once);

    expect(twice).toBe(once);
    // Exactly one injected release signing block.
    expect(once.split(plugin.MARKER)).toHaveLength(2);
  });

  it('throws if the signingConfigs block is missing', () => {
    expect(() => plugin.applyAndroidReleaseSigning('android {\n    buildTypes {}\n}')).toThrow(/signingConfigs/);
  });

  it('rewrites only the release build type even when it precedes debug', () => {
    // Defend against a future Expo template that emits `release` before `debug`
    // inside buildTypes — the lazy regex must still target the release line.
    const releaseFirst = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
        debug {
            signingConfig signingConfigs.debug
        }
    }
}`;

    const result = plugin.applyAndroidReleaseSigning(releaseFirst);

    expect(result).toContain(plugin.RELEASE_SIGNING_CONFIG_LINE);
    // The trailing debug build type keeps the plain debug-key line.
    expect(result).toMatch(/debug\s*\{\s*signingConfig signingConfigs\.debug\s*\}/);
  });

  it('throws if the template already defines a release signing config', () => {
    // A future Expo SDK shipping its own release signing config must fail loudly
    // rather than inject a duplicate `release {}` (a cryptic Gradle DSL error).
    const preexistingReleaseConfig = `android {
    signingConfigs {
        debug { storeFile file('debug.keystore') }
        release { storeFile file('upload.keystore') }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}`;

    expect(() => plugin.applyAndroidReleaseSigning(preexistingReleaseConfig)).toThrow(/already defines a .?release/);
  });

  it('throws if the release build type has no debug signing line to replace', () => {
    const noReleaseSigning = `android {
    signingConfigs {
        debug { storeFile file('debug.keystore') }
    }
    buildTypes {
        release {
            minifyEnabled true
        }
    }
}`;

    expect(() => plugin.applyAndroidReleaseSigning(noReleaseSigning)).toThrow(/release build type/);
  });
});
