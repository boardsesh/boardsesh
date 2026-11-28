import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type GradleProperty = { type: string; key?: string; value?: string };

type NoDocumentScannerPlugin = {
  applyDocumentScannerProperty(gradleProps: GradleProperty[]): GradleProperty[];
  applyDocumentScannerExclude(contents: string): string;
  DOCUMENT_SCANNER_PROPERTY: string;
  DOCUMENT_SCANNER_GROUP: string;
  DOCUMENT_SCANNER_MODULE: string;
  EXCLUDE_MARKER: string;
};

const plugin = require('../../../plugins/with-android-camera-no-document-scanner.js') as NoDocumentScannerPlugin;

const expoCameraRoot = dirname(require.resolve('expo-camera/package.json'));
const expoCameraVersion = (require('expo-camera/package.json') as { version: string }).version;

const TEMPLATE_BUILD_GRADLE = `apply plugin: "com.android.application"

android {
    namespace 'com.boardsesh.app'
}

dependencies {
    implementation("com.facebook.react:react-android")
}
`;

describe('with-android-camera-no-document-scanner', () => {
  it('turns expo-camera’s document scanner switch off in gradle.properties', () => {
    const props = plugin.applyDocumentScannerProperty([
      { type: 'property', key: 'org.gradle.parallel', value: 'false' },
    ]);
    expect(props).toEqual([
      { type: 'property', key: 'org.gradle.parallel', value: 'false' },
      { type: 'property', key: 'expo.camera.document-scanner-enabled', value: 'false' },
    ]);
  });

  it('overrides a switch someone turned back on, and writes it once', () => {
    const props = plugin.applyDocumentScannerProperty([
      { type: 'property', key: 'expo.camera.document-scanner-enabled', value: 'true' },
    ]);
    const again = plugin.applyDocumentScannerProperty(structuredClone(props));
    expect(again).toEqual([{ type: 'property', key: 'expo.camera.document-scanner-enabled', value: 'false' }]);
  });

  it('excludes the document scanner artifact from the app, once', () => {
    const once = plugin.applyDocumentScannerExclude(TEMPLATE_BUILD_GRADLE);
    expect(once.startsWith(TEMPLATE_BUILD_GRADLE.trimEnd())).toBe(true);
    expect(once).toContain("exclude group: 'com.google.android.gms', module: 'play-services-mlkit-document-scanner'");
    expect(plugin.applyDocumentScannerExclude(once)).toBe(once);
  });

  it('is deterministic: the same input always gives the same build files', () => {
    expect(plugin.applyDocumentScannerExclude(TEMPLATE_BUILD_GRADLE)).toBe(
      plugin.applyDocumentScannerExclude(TEMPLATE_BUILD_GRADLE),
    );
  });

  // Upstream drift guards: an expo-camera bump that renames the switch or the
  // artifact would make this plugin a silent no-op.
  it('names the switch expo-camera’s build.gradle still reads', () => {
    const buildGradle = readFileSync(join(expoCameraRoot, 'android', 'build.gradle'), 'utf8');
    expect(buildGradle).toContain(`findProperty('${plugin.DOCUMENT_SCANNER_PROPERTY}')`);
    expect(buildGradle).toContain(`${plugin.DOCUMENT_SCANNER_GROUP}:${plugin.DOCUMENT_SCANNER_MODULE}:`);
  });

  it('names the artifact the prebuilt AAR pulls in at runtime', () => {
    const moduleMetadata = readFileSync(
      join(
        expoCameraRoot,
        'local-maven-repo/host/exp/exponent/expo.modules.camera',
        expoCameraVersion,
        `expo.modules.camera-${expoCameraVersion}.module`,
      ),
      'utf8',
    );
    const metadata = JSON.parse(moduleMetadata) as {
      variants: Array<{ attributes: Record<string, string>; dependencies?: Array<{ group: string; module: string }> }>;
    };
    const runtimeDependencies = metadata.variants
      .filter((variant) => variant.attributes['org.gradle.usage'] === 'java-runtime')
      .flatMap((variant) => variant.dependencies ?? []);
    expect(runtimeDependencies).toContainEqual(
      expect.objectContaining({ group: plugin.DOCUMENT_SCANNER_GROUP, module: plugin.DOCUMENT_SCANNER_MODULE }),
    );
    // The barcode scanner, which reads the code, stays.
    expect(runtimeDependencies).toContainEqual(
      expect.objectContaining({ group: 'com.google.mlkit', module: 'barcode-scanning' }),
    );
  });
});
