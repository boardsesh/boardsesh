import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards issue #4101: Android release builds shipped with NO Sentry source
// maps because SENTRY_DISABLE_AUTO_UPLOAD was hardcoded 'true' unconditionally
// (a workaround for a Gradle/exec() incompatibility that was fixed upstream in
// @sentry/react-native 7.3.0 — we're pinned to 7.11.0). Every Android JS error
// then merged into one unsymbolicated Sentry issue. The fix mirrors
// ios-testflight-rn.yml: gate the upload on SENTRY_AUTH_TOKEN presence instead
// of disabling it outright. This test fails the build if either build step
// regresses back to an unconditional disable, or drops the token wiring.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/android-apk-rn.yml');

function readAndroidWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

describe('Android RN release: Sentry source map upload gate (#4101)', () => {
  it('never hardcodes SENTRY_DISABLE_AUTO_UPLOAD to a fixed value in a step env block', () => {
    // The only legitimate literal assignment is inside the "Configure Sentry
    // source map upload" step's conditional shell (echoed to $GITHUB_ENV, not a
    // step-level `env:` block) — a hardcoded `SENTRY_DISABLE_AUTO_UPLOAD: 'true'`
    // in an env: block (as the APK/AAB build steps used to carry) permanently
    // overrides the token gate for that step regardless of secret presence.
    const workflow = readAndroidWorkflow();
    expect(workflow).not.toMatch(/SENTRY_DISABLE_AUTO_UPLOAD:\s*'(?:true|false)'/);
  });

  it('gates the upload on SENTRY_AUTH_TOKEN presence, matching the iOS pattern', () => {
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/if \[ -n "\$SENTRY_AUTH_TOKEN" \]; then/);
    expect(workflow).toMatch(/echo "SENTRY_DISABLE_AUTO_UPLOAD=false" >> "\$GITHUB_ENV"/);
    expect(workflow).toMatch(/echo "SENTRY_DISABLE_AUTO_UPLOAD=true" >> "\$GITHUB_ENV"/);
  });

  it('passes SENTRY_AUTH_TOKEN into both the APK and AAB Gradle build steps', () => {
    // sentry.gradle's upload task reads the auth token from this env var (our
    // non-flavor-aware sentry.properties never commits one) — without it here,
    // SENTRY_DISABLE_AUTO_UPLOAD=false still uploads nothing (auth failure).
    const workflow = readAndroidWorkflow();
    const occurrences = workflow.match(/SENTRY_AUTH_TOKEN:\s*\$\{\{\s*secrets\.SENTRY_AUTH_TOKEN\s*\}\}/g) ?? [];
    // Once in the gate step, once in the APK build step, once in the AAB build step.
    expect(occurrences.length).toBe(3);
  });

  it('keeps runtime Sentry (EXPO_PUBLIC_SENTRY_DSN) enabled regardless of the upload gate', () => {
    // Source-map upload and runtime error reporting are independent — a missing
    // token should degrade symbolication, never crash reporting itself.
    const workflow = readAndroidWorkflow();
    expect(workflow).toMatch(/EXPO_PUBLIC_SENTRY_DSN: https:\/\/[^\s]+\.ingest\.[^\s]+\.sentry\.io\/\d+/);
  });
});
