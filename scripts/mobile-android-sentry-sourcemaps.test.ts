/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Native releases upload explicitly after packaging and fail closed when
// exact bundle maps or owned native symbols cannot be processed.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/android-apk-rn.yml');

function readAndroidWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

describe('Android RN release: Sentry source map upload (#4101)', () => {
  it('keeps the Gradle-embedded sentry.gradle upload task disabled (unverified via branch dispatch)', () => {
    const workflow = readAndroidWorkflow();
    // Both the APK and AAB Gradle invocations must force it off.
    expect(workflow.match(/SENTRY_DISABLE_AUTO_UPLOAD:\s*'true'/g)?.length).toBe(2);
    expect(workflow).toMatch(/echo "SENTRY_DISABLE_AUTO_UPLOAD=true" >> "\$GITHUB_ENV"/);
  });

  it('requires the explicit source-map upload before releasing', () => {
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/- name: Upload Sentry source maps/);
    const uploadStepIndex = workflow.indexOf('- name: Upload Sentry source maps');
    const uploadStepBlock = workflow.slice(uploadStepIndex, uploadStepIndex + 2000);
    expect(uploadStepBlock).not.toMatch(/continue-on-error:\s*true/);
    expect(uploadStepBlock).toMatch(/if:\s*env\.SENTRY_UPLOAD_ENABLED == 'true'/);
  });

  it('gates the upload on SENTRY_AUTH_TOKEN presence', () => {
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/if \[ -n "\$SENTRY_AUTH_TOKEN" \]; then/);
    expect(workflow).toMatch(/echo "SENTRY_UPLOAD_ENABLED=true" >> "\$GITHUB_ENV"/);
    expect(workflow).toContain('SENTRY_AUTH_TOKEN is required for release diagnostics.');
    const occurrences = workflow.match(/SENTRY_AUTH_TOKEN:\s*\$\{\{\s*secrets\.SENTRY_AUTH_TOKEN\s*\}\}/g) ?? [];
    // Configuration, APK maps, R8 mapping, AAB maps and native symbols.
    expect(occurrences.length).toBe(5);
  });

  // R8 mappings and JS maps must both be accepted before store publication.
  describe('R8 mapping upload', () => {
    it('uploads the mapping under the UUID the binary carries', () => {
      const workflow = readAndroidWorkflow();

      expect(workflow).toMatch(/sentry-cli upload-proguard/);
      expect(workflow).toMatch(/--uuid "\$BOARDSESH_SENTRY_PROGUARD_UUID"/);
      // Without --require-one a moved output path exits 0 having uploaded nothing.
      expect(workflow).toMatch(/--require-one/);
    });

    it('mints the UUID before prebuild writes the manifest', () => {
      const workflow = readAndroidWorkflow();

      const mint = workflow.indexOf('BOARDSESH_SENTRY_PROGUARD_UUID=$(uuidgen)');
      const prebuild = workflow.indexOf('expo prebuild --platform android');
      expect(mint).toBeGreaterThan(-1);
      expect(prebuild).toBeGreaterThan(-1);
      // Reversed, the binary ships with no proguard-uuid and the uploaded mapping
      // can never be matched to it — a silent, permanent loss of symbolication.
      expect(mint).toBeLessThan(prebuild);
    });

    it('blocks the release when the R8 mapping upload fails', () => {
      const workflow = readAndroidWorkflow();
      const start = workflow.indexOf('- name: Upload Sentry ProGuard mapping');
      const step = workflow.slice(start, workflow.indexOf('      - name:', start + 1));

      expect(step).not.toMatch(/continue-on-error:\s*true/);
      expect(start).toBeLessThan(workflow.indexOf('id: play_upload'));
      expect(step).toMatch(/if:\s*env\.SENTRY_UPLOAD_ENABLED == 'true'/);
    });

    it('keeps the Gradle-embedded Sentry upload disabled', () => {
      const workflow = readAndroidWorkflow();

      // The decoupled steps replace the Gradle task; re-enabling it would put
      // Sentry back on the release critical path (see #4101).
      expect(workflow).toMatch(/SENTRY_DISABLE_AUTO_UPLOAD/);
      expect(workflow).not.toMatch(/SENTRY_DISABLE_AUTO_UPLOAD:\s*'false'/);
    });
  });

  it('propagates the Metro debug ID into the Hermes-composed source map before uploading', () => {
    // sentry.gradle does this too (Hermes's compose-source-maps step doesn't
    // carry the debug ID on its own) — skipping it silently breaks
    // symbolication even though the upload itself "succeeds".
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/copy-debugid\.js/);
  });

  it('uploads actual packaged bundles by matching Debug ID and waits strictly', () => {
    const workflow = readAndroidWorkflow();
    expect(workflow).toContain('unzip -p "$apk_path" assets/index.android.bundle');
    expect(workflow).toContain('unzip -p "$aab_path" base/assets/index.android.bundle');
    expect(workflow).toContain('cmp "$bundle_path" "$packaged_bundle"');
    expect(workflow).toContain('mobile-upload-embedded-sourcemaps.ts');
    const uploader = readFileSync(resolve(REPO_ROOT, 'scripts/mobile-upload-sourcemaps.ts'), 'utf8');
    expect(uploader).toContain("'--wait'");
    expect(uploader).toContain("'--strict'");
  });

  it('keeps runtime Sentry (EXPO_PUBLIC_SENTRY_DSN) enabled regardless of the upload gate', () => {
    // Source-map upload and runtime error reporting are independent — a missing
    // token or a failed upload should degrade symbolication only, never crash
    // reporting itself.
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/EXPO_PUBLIC_SENTRY_DSN: https:\/\/[^\s]+\.ingest\.[^\s]+\.sentry\.io\/\d+/);
  });
});
