/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards issue #4101: Android release builds shipped with NO Sentry source
// maps because SENTRY_DISABLE_AUTO_UPLOAD was hardcoded 'true' unconditionally
// on the Gradle-embedded sentry.gradle upload task, with no fallback — every
// Android JS error then merged into one unsymbolicated Sentry issue.
//
// The fix keeps the Gradle-embedded task disabled (re-enabling it can't be
// verified via a feature-branch workflow_dispatch first — the Production
// GitHub environment's deployment-branch policy only allows `main` — and a
// build failure there would take down the whole Android release, not just
// symbolication) and instead adds a decoupled, continue-on-error step that
// uploads the same Gradle-generated JS bundle/sourcemap explicitly via
// sentry-cli, so a Sentry-side failure can never block shipping the release.
// This test fails the build if either regresses: the Gradle-embedded task
// silently re-enabling without having been verified, or the decoupled upload
// step disappearing / losing its non-blocking guarantee.

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

  it('adds a decoupled, continue-on-error Sentry source map upload step', () => {
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/- name: Upload Sentry source maps/);
    const uploadStepIndex = workflow.indexOf('- name: Upload Sentry source maps');
    const uploadStepBlock = workflow.slice(uploadStepIndex, uploadStepIndex + 2000);
    // Must never block the release: it runs after the APK is already built and
    // verified, and a Sentry-side failure must not fail the job.
    expect(uploadStepBlock).toMatch(/continue-on-error:\s*true/);
    expect(uploadStepBlock).toMatch(/if:\s*env\.SENTRY_UPLOAD_ENABLED == 'true'/);
  });

  it('gates the upload on SENTRY_AUTH_TOKEN presence', () => {
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/if \[ -n "\$SENTRY_AUTH_TOKEN" \]; then/);
    expect(workflow).toMatch(/echo "SENTRY_UPLOAD_ENABLED=true" >> "\$GITHUB_ENV"/);
    expect(workflow).toMatch(/echo "SENTRY_UPLOAD_ENABLED=false" >> "\$GITHUB_ENV"/);
    const occurrences = workflow.match(/SENTRY_AUTH_TOKEN:\s*\$\{\{\s*secrets\.SENTRY_AUTH_TOKEN\s*\}\}/g) ?? [];
    // Once in the gate step, once in the explicit upload step.
    expect(occurrences.length).toBe(2);
  });

  it('propagates the Metro debug ID into the Hermes-composed source map before uploading', () => {
    // sentry.gradle does this too (Hermes's compose-source-maps step doesn't
    // carry the debug ID on its own) — skipping it silently breaks
    // symbolication even though the upload itself "succeeds".
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/copy-debugid\.js/);
  });

  it('uploads via sentry-cli with a release/dist convention matching runtime auto-detection', () => {
    // src/lib/sentry.ts intentionally leaves release/dist unset so the native
    // SDK auto-detects them from the installed build's applicationId/versionName
    // /versionCode — the uploaded artifacts must be tagged with the exact same
    // convention (sentry.gradle's own defaultReleaseName format) or events never
    // resolve to these source maps.
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/sentry-cli react-native gradle/);
    expect(workflow).toMatch(/--release "com\.boardsesh\.app@\$\{BOARDSESH_MOBILE_VERSION\}\+\$\{VERSION_CODE\}"/);
    expect(workflow).toMatch(/--dist "\$\{VERSION_CODE\}"/);
  });

  it('keeps runtime Sentry (EXPO_PUBLIC_SENTRY_DSN) enabled regardless of the upload gate', () => {
    // Source-map upload and runtime error reporting are independent — a missing
    // token or a failed upload should degrade symbolication only, never crash
    // reporting itself.
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/EXPO_PUBLIC_SENTRY_DSN: https:\/\/[^\s]+\.ingest\.[^\s]+\.sentry\.io\/\d+/);
  });
});
