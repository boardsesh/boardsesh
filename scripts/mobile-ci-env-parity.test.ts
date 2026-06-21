/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards the env the three mobile workflows share, for two reasons:
//
//   1. Fingerprint parity. runtimeVersion uses the `fingerprint` policy
//      (packages/mobile/app.config.ts), so an OTA only reaches a binary whose
//      fingerprint matches. The fingerprint hashes the *resolved Expo config*
//      (NOT the JS bundle), so only the config-affecting vars below move it:
//      EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID (→ google-signin iosUrlScheme),
//      GOOGLE_MAPS_API_KEY (handled per-platform, see the dedicated test), and —
//      once the committed cert activates the self-hosted updates block —
//      EXPO_UPDATES_URL + EXPO_UPDATES_CHANNEL. If any of these drift between the
//      OTA publish (mobile-ota-production.yml) and the native builds
//      (ios-testflight-rn.yml / android-apk-rn.yml), the published fingerprint
//      won't match the shipped binary and the OTA silently never lands.
//   2. Bundle correctness. The remaining EXPO_PUBLIC_* are inlined into the JS
//      bundle (not the fingerprint); drift there ships an OTA pointing at the
//      wrong backend/analytics — a runtime bug, not a delivery failure.
//
// Either failure is silent in CI, so this test fails the build when the env
// blocks drift.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');

const NATIVE_IOS = 'ios-testflight-rn.yml';
const NATIVE_ANDROID = 'android-apk-rn.yml';
const OTA = 'mobile-ota-production.yml';
// The PR-time OTA-compatibility check (mobile-ota-check.yml) resolves the same
// fingerprint, so its fingerprint-affecting env must stay locked to the native
// builds — or it would report a verdict against an env the binaries never had.
const OTA_CHECK = 'mobile-ota-check.yml';

// Workflow-level env keys that feed the resolved config (fingerprint) and/or the
// inlined JS bundle (runtime correctness). Every one must be declared identically
// in all three workflows. They live at the workflow level (not job level) so the
// fingerprint `gate` job and the build job within a workflow can't drift.
// GOOGLE_MAPS_API_KEY is handled separately (Android-only — see below).
const SHARED_ENV_KEYS = [
  'EXPO_PUBLIC_BACKEND_URL',
  'EXPO_PUBLIC_WS_URL',
  'EXPO_PUBLIC_WEB_URL',
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_SENTRY_DSN',
  'EXPO_PUBLIC_POSTHOG_KEY',
  'EXPO_UPDATES_CHANNEL',
  'EXPO_UPDATES_URL',
] as const;

function readWorkflow(name: string): string {
  return readFileSync(resolve(WORKFLOW_DIR, name), 'utf8');
}

/** Extract a workflow-level `env:` value (2-space indent) by key, or null. */
function workflowEnvValue(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^ {2}${key}:[ \\t]*(.+?)\\s*$`, 'm'));
  return match ? match[1] : null;
}

describe('mobile CI env parity (OTA fingerprint invariant)', () => {
  // The PR-time OTA-compat check resolves the same fingerprint as the native
  // builds + OTA publish, so it must share the same fingerprint-affecting env.
  const workflows = [NATIVE_IOS, NATIVE_ANDROID, OTA, OTA_CHECK];

  it.each(SHARED_ENV_KEYS)('declares %s identically across all mobile fingerprint workflows', (key) => {
    const values = workflows.map((name) => ({ name, value: workflowEnvValue(readWorkflow(name), key) }));

    for (const { name, value } of values) {
      expect(value, `${key} missing from ${name} workflow env`).not.toBeNull();
    }

    const distinct = new Set(values.map((entry) => entry.value));
    expect(
      distinct.size,
      `${key} drifted across the mobile workflows: ${JSON.stringify(values)}. For a ` +
        `config-affecting var this desyncs the fingerprint runtimeVersion (the OTA never reaches ` +
        `the binary); for a bundle-only var it ships an OTA pointing at the wrong backend/analytics. ` +
        `Keep all the mobile fingerprint workflows in lockstep.`,
    ).toBe(1);
  });

  it('keeps GOOGLE_MAPS_API_KEY out of the PR OTA-compat check (it diffs vs main without the key)', () => {
    // mobile-ota-check.yml intentionally omits GOOGLE_MAPS_API_KEY: it's a
    // Production-environment secret, unavailable on feature-branch pushes, and the
    // diff-vs-main verdict doesn't need it — a missing key shifts BOTH sides of
    // the comparison equally. Re-adding it here would reintroduce a Production
    // dependency the branch push can't satisfy, so guard the omission.
    const otaCheck = readWorkflow(OTA_CHECK);
    expect(otaCheck).not.toMatch(/^\s*GOOGLE_MAPS_API_KEY:/m);
  });

  it('publishes the Android OTA with the same GOOGLE_MAPS_API_KEY the Android build bakes in', () => {
    // GOOGLE_MAPS_API_KEY is set only on the Android prebuild (iOS uses Apple
    // Maps) and changes the resolved android.config block — hence the fingerprint.
    // The OTA workflow must set the same value on its Android publish step, and
    // must NOT set it on the iOS publish, or one platform's OTA can never match.
    const androidBuild = readWorkflow(NATIVE_ANDROID);
    const ota = readWorkflow(OTA);
    const keyExpr = /GOOGLE_MAPS_API_KEY:\s*\$\{\{\s*secrets\.GOOGLE_MAPS_API_KEY\s*\}\}/;

    expect(androidBuild).toMatch(keyExpr);
    expect(ota, 'OTA workflow must set GOOGLE_MAPS_API_KEY for the Android publish').toMatch(keyExpr);
    // Exactly one occurrence in the OTA workflow → it scopes to the Android step,
    // not the iOS publish (which must run without it).
    expect(ota.match(/GOOGLE_MAPS_API_KEY:/g)?.length ?? 0).toBe(1);
  });

  it('keeps the OTA publish on the self-hosted server (production channel)', () => {
    const ota = readWorkflow(OTA);
    expect(workflowEnvValue(ota, 'EXPO_UPDATES_CHANNEL')).toBe('production');
    expect(ota).toMatch(/--channel production --platform ios/);
    expect(ota).toMatch(/--channel production --platform android/);
  });

  it('gates each native build on its platform fingerprint (resolve + per-platform tag)', () => {
    // The gate resolves the runtimeVersion fingerprint and skips the native build
    // when a fingerprint-<platform>-<hash> tag already exists; the build records
    // that tag on success. Per-platform because the fingerprints differ
    // (GOOGLE_MAPS_API_KEY perturbs only Android) — a shared tag would be wrong.
    const ios = readWorkflow(NATIVE_IOS);
    const android = readWorkflow(NATIVE_ANDROID);

    expect(ios).toMatch(/runtimeversion:resolve --platform ios/);
    expect(ios).toMatch(/fingerprint-ios-/);
    expect(android).toMatch(/runtimeversion:resolve --platform android/);
    expect(android).toMatch(/fingerprint-android-/);
  });

  it('forces the binary onto the gate fingerprint, and the OTA publish resolves fresh (never pinned)', () => {
    // The iOS binary is baked on macOS but the gate/publish run on Linux, and
    // @expo/fingerprint is not deterministic across the two. The native builds set
    // EXPO_UPDATES_FINGERPRINT_OVERRIDE to the gate's Linux fingerprint so the binary
    // embeds the *Linux* value (app.config emits it as a literal runtimeVersion) —
    // which the Linux publish then matches.
    const ios = readWorkflow(NATIVE_IOS);
    const android = readWorkflow(NATIVE_ANDROID);
    const ota = readWorkflow(OTA);
    const gatePin = /EXPO_UPDATES_FINGERPRINT_OVERRIDE:\s*\$\{\{\s*needs\.gate\.outputs\.fingerprint\s*\}\}/;

    // Native builds embed the gate's canonical (Linux) fingerprint.
    expect(ios, 'iOS build must pin the binary to the gate fingerprint').toMatch(gatePin);
    expect(android, 'Android build must pin the binary to the gate fingerprint').toMatch(gatePin);

    // The divergence source is gone: exactly one runtimeversion:resolve per native
    // workflow (the gate). A second occurrence means a build-side re-resolve crept
    // back in — the macOS/Linux split that stranded iOS OTAs.
    expect(ios.match(/runtimeversion:resolve --platform ios/g)?.length ?? 0).toBe(1);
    expect(android.match(/runtimeversion:resolve --platform android/g)?.length ?? 0).toBe(1);

    // CRITICAL: the OTA publish must NEVER pin the fingerprint. It resolves the
    // CURRENT commit's fingerprint fresh and publishes under it. Pinning to a fixed
    // value (e.g. the last shipped tag) would, on a native-change commit, serve the
    // new JS to OLD binaries under the old runtimeVersion — bypassing the fingerprint
    // compatibility check and crashing installs that lack the new native code.
    // Match a real YAML env-key line (`KEY:`), not a comment that names the var.
    expect(
      /^\s*EXPO_UPDATES_FINGERPRINT_OVERRIDE:/m.test(ota),
      'The OTA publish must not set EXPO_UPDATES_FINGERPRINT_OVERRIDE — it resolves the current ' +
        'fingerprint fresh. Pinning it would deliver native-dependent JS to incompatible old binaries.',
    ).toBe(false);
  });

  it('resolves the iOS fingerprint without GOOGLE_MAPS_API_KEY and Android with it', () => {
    // GOOGLE_MAPS_API_KEY changes the resolved android.config — hence the
    // fingerprint — so the gate must mirror the per-platform split the native
    // builds bake in: never set on iOS (Apple Maps), set on Android, or a gate
    // resolves a fingerprint the binary never had and skips/builds wrongly.
    const ios = readWorkflow(NATIVE_IOS);
    const android = readWorkflow(NATIVE_ANDROID);

    // No env assignment of the key anywhere in the iOS workflow (a comment that
    // merely names it is fine — match a YAML/shell key, not the bare word).
    expect(ios).not.toMatch(/^\s*GOOGLE_MAPS_API_KEY:/m);
    expect(android).toMatch(/^\s*GOOGLE_MAPS_API_KEY:\s*\$\{\{\s*secrets\.GOOGLE_MAPS_API_KEY\s*\}\}/m);
  });
});
