import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SAMPLE_APP_BUILD_GRADLE, SAMPLE_PROGUARD_RULES } from '../../../test/expo-android-template';

const require = createRequire(import.meta.url);

type GradleProperty = { type: string; key?: string; value?: string };

type AndroidMinifyPlugin = {
  applyMinifyProperties(gradleProps: GradleProperty[]): GradleProperty[];
  assertTemplateReadsMinifyProperty(contents: string): string;
  applyProguardBaseFile(contents: string): string;
  applyKeepRules(contents: string): string;
  MINIFY_PROPERTY: string;
  SHRINK_RESOURCES_PROPERTY: string;
  ENABLE_SHRINK_RESOURCES: boolean;
  PROGUARD_BASE_FILE: string;
  KEEP_RULES_MARKER: string;
  KEEP_RULES: string;
};

const plugin = require('../../../plugins/with-android-minify.js') as AndroidMinifyPlugin;

const MOBILE_ROOT = join(__dirname, '../../..');

describe('with-android-minify', () => {
  describe('gradle properties', () => {
    it('turns minification on for release builds', () => {
      const result = plugin.applyMinifyProperties([]);

      expect(result).toContainEqual({ type: 'property', key: plugin.MINIFY_PROPERTY, value: 'true' });
    });

    it('overwrites an existing false rather than appending a duplicate', () => {
      const result = plugin.applyMinifyProperties([{ type: 'property', key: plugin.MINIFY_PROPERTY, value: 'false' }]);

      const entries = result.filter((entry) => entry.key === plugin.MINIFY_PROPERTY);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.value).toBe('true');
    });

    it('is idempotent across repeated prebuilds', () => {
      const once = plugin.applyMinifyProperties([]);
      const twice = plugin.applyMinifyProperties(plugin.applyMinifyProperties([]));

      expect(twice).toStrictEqual(once);
    });

    // Resource shrinking is a separate axis with a silent failure mode (drawables
    // reached by name get stripped) and it contributes nothing to the obfuscation
    // percentage. If someone flips the constant, this test is where they find the
    // reasoning; until then it pins the property OFF.
    it('leaves resource shrinking alone', () => {
      expect(plugin.ENABLE_SHRINK_RESOURCES).toBe(false);

      const result = plugin.applyMinifyProperties([]);

      expect(result.some((entry) => entry.key === plugin.SHRINK_RESOURCES_PROPERTY)).toBe(false);
    });
  });

  describe('template guard', () => {
    it('accepts the SDK 57 template shape', () => {
      expect(plugin.assertTemplateReadsMinifyProperty(SAMPLE_APP_BUILD_GRADLE)).toBe(SAMPLE_APP_BUILD_GRADLE);
    });

    // The whole point of the guard: a renamed property means our gradle property
    // is written but never read, the build stays green, and the release ships
    // unobfuscated at 1%.
    it('throws when the template renames the property', () => {
      const renamed = SAMPLE_APP_BUILD_GRADLE.replaceAll(
        'android.enableMinifyInReleaseBuilds',
        'android.enableR8InReleaseBuilds',
      );

      expect(() => plugin.assertTemplateReadsMinifyProperty(renamed)).toThrow(/no longer reads/);
    });

    it('throws when the release build type hardcodes minifyEnabled false', () => {
      const hardcoded = SAMPLE_APP_BUILD_GRADLE.replace(
        'minifyEnabled enableMinifyInReleaseBuilds',
        'minifyEnabled false',
      );

      expect(() => plugin.assertTemplateReadsMinifyProperty(hardcoded)).toThrow(/no longer applies/);
    });

    // Pins the lazy `buildTypes { ... release {` anchoring. `debug {` is textually
    // first inside buildTypes, so a regex that forgot to anchor on the release
    // block would happily match the debug occurrence and wave through a template
    // that never minifies the release build. This is the test most likely to catch
    // a bad edit to MINIFY_APPLIED_IN_RELEASE.
    it('throws when minification is wired only into the debug build type', () => {
      const debugOnly = SAMPLE_APP_BUILD_GRADLE.replace(
        'minifyEnabled enableMinifyInReleaseBuilds',
        'minifyEnabled false',
      ).replace(
        'debug {\n            signingConfig',
        'debug {\n            minifyEnabled enableMinifyInReleaseBuilds\n            signingConfig',
      );

      expect(debugOnly).toContain('minifyEnabled enableMinifyInReleaseBuilds');
      expect(() => plugin.assertTemplateReadsMinifyProperty(debugOnly)).toThrow(/no longer applies/);
    });
  });

  describe('proguard base file', () => {
    it('swaps AGP’s stock file for the -optimize variant', () => {
      const result = plugin.applyProguardBaseFile(SAMPLE_APP_BUILD_GRADLE);

      expect(result).toContain(`getDefaultProguardFile("${plugin.PROGUARD_BASE_FILE}")`);
      expect(result).not.toContain('getDefaultProguardFile("proguard-android.txt")');
      // The app-level rules file must still be on the list, or none of the keeps
      // below reach R8.
      expect(result).toContain('"proguard-rules.pro"');
    });

    it('is idempotent', () => {
      const once = plugin.applyProguardBaseFile(SAMPLE_APP_BUILD_GRADLE);

      expect(plugin.applyProguardBaseFile(once)).toBe(once);
    });

    it('throws when the proguardFiles line is gone', () => {
      const withoutLine = SAMPLE_APP_BUILD_GRADLE.replace(
        'proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"',
        'proguardFiles "proguard-rules.pro"',
      );

      expect(() => plugin.applyProguardBaseFile(withoutLine)).toThrow(/could not find/);
    });
  });

  describe('keep rules', () => {
    it('appends the block once and preserves the template’s own keeps', () => {
      const result = plugin.applyKeepRules(SAMPLE_PROGUARD_RULES);

      expect(result).toContain('-keep class com.swmansion.reanimated.** { *; }');
      expect(result).toContain('-keep class com.facebook.react.turbomodule.** { *; }');
      expect(result.split(plugin.KEEP_RULES_MARKER)).toHaveLength(3);
    });

    it('is idempotent across repeated prebuilds', () => {
      const once = plugin.applyKeepRules(SAMPLE_PROGUARD_RULES);

      expect(plugin.applyKeepRules(once)).toBe(once);
    });

    it('keeps the reflectively-loaded Expo module list', () => {
      expect(plugin.KEEP_RULES).toContain('-keep class expo.modules.ExpoModulesPackageList');
    });

    it('keeps the JNI bridge class and method names', () => {
      expect(plugin.KEEP_RULES).toContain(
        '-keepclasseswithmembernames class com.boardsesh.boardrenderer.BoardRendererBridge',
      );
    });

    it('keeps the two class names Sentry compares as strings', () => {
      expect(plugin.KEEP_RULES).toContain('-keepnames class com.swmansion.rnscreens.ScreenStackFragment');
      expect(plugin.KEEP_RULES).toContain('-keepnames class com.swmansion.rnscreens.events.ScreenAppearEvent');
    });

    it('keeps line numbers so a retraced stack trace still points at a line', () => {
      expect(plugin.KEEP_RULES).toContain('-keepattributes SourceFile,LineNumberTable');
    });

    // A blanket suppression turns a loud, correct R8 build failure into the silent
    // runtime failure this whole plugin exists to avoid. Missing classes are
    // discovered from AGP's own missing_rules.txt and fixed with narrow rules.
    it('never suppresses warnings wholesale', () => {
      expect(plugin.KEEP_RULES).not.toContain('-ignorewarnings');
      expect(plugin.KEEP_RULES).not.toMatch(/-dontwarn\s+\*\*/);
      expect(plugin.KEEP_RULES).not.toMatch(/-keep\s+class\s+\*\*\s*\{/);
    });
  });

  // These read the real upstream artifacts rather than a fixture, in the same
  // spirit as scripts/native-release-workflows.test.ts reading the workflow YAML.
  // A keep rule is a promise about a name that lives in someone else's file; when
  // that name moves, the rule silently stops covering anything.
  describe('drift against the sources the rules promise about', () => {
    it('pins the JNI class the native library actually exports', () => {
      const jni = readFileSync(join(MOBILE_ROOT, 'modules/board-renderer/android/src/main/cpp/jni_bridge.cpp'), 'utf8');

      const symbol = jni.match(/Java_([A-Za-z0-9_]+)_nativeRender/)?.[1];
      expect(symbol, 'jni_bridge.cpp no longer exports a *_nativeRender symbol').toBeDefined();

      // JNI mangles `.` as `_`, so the symbol's package path maps back to the FQN.
      const fqn = symbol!.replaceAll('_', '.');
      expect(fqn).toBe('com.boardsesh.boardrenderer.BoardRendererBridge');
      expect(plugin.KEEP_RULES).toContain(fqn);
    });

    // Breaks on a @sentry/react-native bump — which is the point: that bump is
    // exactly when these two -keepnames might need to change.
    it('pins the class names @sentry/react-native still compares as strings', () => {
      const tracer = readFileSync(
        join(
          MOBILE_ROOT,
          'node_modules/@sentry/react-native/android/src/main/java/io/sentry/react/RNSentryReactFragmentLifecycleTracer.java',
        ),
        'utf8',
      );

      expect(tracer).toContain('"com.swmansion.rnscreens.ScreenStackFragment"');
      expect(tracer).toContain('"com.swmansion.rnscreens.events.ScreenAppearEvent"');
    });
  });
});
