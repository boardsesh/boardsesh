/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
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
//      EXPO_UPDATES_URL. If this drifts between the
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
// The per-PR preview publish (mobile-ota-preview.yml) ships a `pr-<number>` branch
// onto the SAME store binary as production, so it must resolve the identical
// fingerprint. The production channel and xprem header are literals in app.config.
const OTA_PREVIEW = 'mobile-ota-preview.yml';
// The approved-release backport publish (mobile-ota-backport.yml) resolves the
// fingerprint of an OLD release and asserts it against the anchor tag before
// publishing an OTA under it — so its fingerprint-affecting env must match the
// native builds too, or the assertion diverges from the value the shipped binary
// actually embeds.
const OTA_BACKPORT = 'mobile-ota-backport.yml';
const STORE_DRAFT = 'mobile-store-draft.yml';
const ANDROID_PR = 'android-pr-rn.yml';
const IOS_PR = 'ios-rn-ci.yml';
const CI = 'ci.yml';
const MOBILE_SCREENSHOTS_IOS = 'mobile-screenshots-ios.yml';
const NATIVE_GATE = resolve(REPO_ROOT, '.github/actions/mobile-native-gate/action.yml');
const OTA_COMPAT_SCRIPT = resolve(REPO_ROOT, 'scripts/mobile-ota-compat-check.ts');

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
  // Bundle-only (never enters the resolved config, so it doesn't move the
  // fingerprint) but must stay in lockstep: it pins RN's fetch as the global
  // `fetch` instead of expo/fetch, whose NativeResponse tears down JSI promises
  // off-thread and crashes Hermes (Sentry 7595562195). If it drifts out of one
  // workflow, that channel silently reverts to the crashing expo/fetch.
  'EXPO_PUBLIC_USE_RN_FETCH',
  // Bundle-only: manifest base for the offline snapshot bootstrap. Drift ships
  // an OTA whose fresh-board downloads silently fall back to the paged crawl
  // (or fetch a stale bucket) — a behaviour change, not a delivery failure.
  'EXPO_PUBLIC_SNAPSHOT_BASE_URL',
  'EXPO_UPDATES_URL',
] as const;

function readWorkflow(name: string): string {
  return readFileSync(resolve(WORKFLOW_DIR, name), 'utf8');
}

/** Extract a workflow-level `env:` value (2-space indent) by key, or null. */
/** One step's YAML block, from its `- name:` line to the next step's. */
function otaStep(workflow: string, stepName: string): string {
  const start = workflow.indexOf(`      - name: ${stepName}`);
  expect(start, `step "${stepName}" not found`).toBeGreaterThanOrEqual(0);
  const nextStepOffset = workflow.slice(start + 1).indexOf('\n      - name: ');
  return nextStepOffset >= 0 ? workflow.slice(start, start + 1 + nextStepOffset) : workflow.slice(start);
}

function workflowEnvValue(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^ {2}${key}:[ \\t]*(.+?)\\s*$`, 'm'));
  return match ? match[1] : null;
}

// The standalone Expo web export (app.boardsesh.com) is deliberately NOT in the
// fingerprint-parity list above: it is a browser bundle and never enters the
// native fingerprint graph, so locking its env to the native builds would be
// meaningless. It has its own, narrower contract — the telemetry keys must be
// present at BUILD time, because `EXPO_PUBLIC_*` is inlined into the JS bundle
// and both SDKs latch their enablement off these vars at module load
// (src/lib/sentry.ts `isSentryEnabled`, src/lib/posthog-client.ts
// `isAnalyticsEnabled`). Omitting them does not fail the deploy — it ships a
// production browser app with crash reporting and analytics silently off, which
// is exactly what happened until these were added.
describe('Expo web export telemetry (app.boardsesh.com)', () => {
  const PRODUCTION_DEPLOY = 'production-deploy.yml';

  it.each(['EXPO_PUBLIC_SENTRY_DSN', 'EXPO_PUBLIC_POSTHOG_KEY', 'EXPO_PUBLIC_SENTRY_ENVIRONMENT'])(
    'declares %s at workflow level in production-deploy.yml',
    (key) => {
      // Workflow level (2-space indent) specifically: a job-level block is
      // invisible to workflowEnvValue, and moving these into deploy-app-web
      // would silently blind this test.
      expect(workflowEnvValue(readWorkflow(PRODUCTION_DEPLOY), key)).not.toBeNull();
    },
  );

  it('tags the browser app with its own Sentry/PostHog environment', () => {
    // `environment` is init-only in both SDKs, so this build-time value is the
    // only thing separating browser-app events from the native fleet.
    expect(workflowEnvValue(readWorkflow(PRODUCTION_DEPLOY), 'EXPO_PUBLIC_SENTRY_ENVIRONMENT')).toBe('production-web');
  });

  it('reports to the same Sentry project as the native workflows', () => {
    // One project for all three SDKs (see docs) — a divergent DSN here would
    // split the browser app off into its own project without anyone noticing.
    const dsn = workflowEnvValue(readWorkflow(PRODUCTION_DEPLOY), 'EXPO_PUBLIC_SENTRY_DSN');
    expect(dsn).toBe(workflowEnvValue(readWorkflow(NATIVE_ANDROID), 'EXPO_PUBLIC_SENTRY_DSN'));
  });
});

describe('mobile CI env parity (OTA fingerprint invariant)', () => {
  // The PR-time OTA-compat check + the per-PR preview publish resolve the same
  // fingerprint as the native builds + OTA publish, so they must share the same
  // fingerprint-affecting env.
  const workflows = [NATIVE_IOS, NATIVE_ANDROID, OTA, OTA_CHECK, OTA_PREVIEW, OTA_BACKPORT, STORE_DRAFT];

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
    // Assert the per-step scoping directly rather than counting occurrences. A
    // count was a proxy: it happened to imply "Android only" while exactly one
    // step used the key, and broke the moment a second Android-only step (the
    // fingerprint resolve) legitimately needed it. Every step that resolves or
    // publishes must carry the key for Android and omit it for iOS — that is the
    // actual invariant, and it holds however many such steps exist.
    for (const stepName of [
      'Publish Android OTA',
      'Verify the fingerprint still matches the build that asked for this',
    ]) {
      expect(otaStep(ota, stepName), `${stepName} must see GOOGLE_MAPS_API_KEY for Android`).toMatch(
        /GOOGLE_MAPS_API_KEY:/,
      );
    }
    expect(otaStep(ota, 'Publish iOS OTA'), 'the iOS publish must run WITHOUT the maps key').not.toMatch(
      /GOOGLE_MAPS_API_KEY:/,
    );
    // The Android-only steps gate the key on the platform rather than setting it
    // unconditionally, so an iOS republish resolves the iOS fingerprint.
    expect(otaStep(ota, 'Verify the fingerprint still matches the build that asked for this')).toContain(
      "github.event.inputs.platform == 'android' && secrets.GOOGLE_MAPS_API_KEY || ''",
    );
  });

  it('keeps the OTA publish on the self-hosted production branch', () => {
    const ota = readWorkflow(OTA);
    expect(ota).toMatch(/--channel production --platform ios/);
    expect(ota).toMatch(/--channel production --platform android/);
  });

  it('bakes the fixed production + branch-surfing request headers in app.config', () => {
    const appConfig = readFileSync(resolve(REPO_ROOT, 'packages/mobile/app.config.ts'), 'utf8');
    expect(appConfig).toMatch(/'expo-channel-name': 'production'/);
    expect(appConfig).toMatch(/'xprem-branch': ''/);
    expect(appConfig).not.toContain('EXPO_UPDATES_CHANNEL');
  });

  it('keeps retired Android preview links as a compatibility ingress', () => {
    const appConfig = readFileSync(resolve(REPO_ROOT, 'packages/mobile/app.config.ts'), 'utf8');
    expect(appConfig).toContain("host: 'www.boardsesh.com', pathPrefix: '/preview'");
    expect(appConfig).toContain("host: 'boardsesh.com', pathPrefix: '/preview'");
  });

  it('preserves the legacy channel env when resolving frozen release anchors', () => {
    // The backport workflow checks out the old release anchor before resolving
    // its fingerprint. Those app.config.ts versions only emit
    // expo-channel-name when this variable is present. Current app.config.ts
    // ignores it, so keeping it here is safe for both generations.
    expect(workflowEnvValue(readWorkflow(OTA_BACKPORT), 'EXPO_UPDATES_CHANNEL')).toBe('production');
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

  it('resolves every explicit workflow fingerprint through expo-updates from packages/mobile', () => {
    const expectedWorkflowResolvers = [
      { name: NATIVE_IOS, platform: 'ios' },
      { name: NATIVE_ANDROID, platform: 'android' },
      { name: OTA_BACKPORT, platform: '"$PLATFORM"' },
      // The republish guard: a native build asks the OTA workflow to publish under
      // the fingerprint it just shipped, and the workflow re-resolves to confirm
      // main hasn't moved to a new native change in the meantime.
      { name: OTA, platform: '"$PLATFORM"' },
    ];
    for (const { name, platform } of expectedWorkflowResolvers) {
      const source = readWorkflow(name);
      const resolverCalls = source.match(/vp exec expo-updates runtimeversion:resolve/g) ?? [];
      expect(resolverCalls, `${name} must have exactly one explicit runtimeVersion resolver`).toHaveLength(1);
      expect(source).toContain(
        `cd packages/mobile && vp exec expo-updates runtimeversion:resolve --platform ${platform}`,
      );
    }

    const nativeGate = readFileSync(NATIVE_GATE, 'utf8');
    expect(nativeGate.match(/vp exec expo-updates runtimeversion:resolve/g) ?? []).toHaveLength(1);
    expect(nativeGate).toMatch(
      /cd "\$1\/packages\/mobile"[\s\\]+&& TAILSCALE_HOSTS='' vp exec expo-updates runtimeversion:resolve/,
    );

    const otaCompat = readFileSync(OTA_COMPAT_SCRIPT, 'utf8');
    expect(otaCompat).toMatch(
      /execFileSync\('vp', \['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', platform\], \{\s*cwd: mobileDir,/,
    );

    const workflowSources = readdirSync(WORKFLOW_DIR)
      .filter((name) => name.endsWith('.yml'))
      .map(readWorkflow)
      .join('\n');
    expect(workflowSources).not.toMatch(/vp dlx (?:@expo\/fingerprint|fingerprint:generate)/);
  });

  it('runs every automatic fingerprint surface when root linker or patch inputs change', () => {
    const automaticFingerprintWorkflows = [NATIVE_IOS, NATIVE_ANDROID, OTA, OTA_CHECK, OTA_PREVIEW, ANDROID_PR, IOS_PR];
    for (const name of automaticFingerprintWorkflows) {
      const source = readWorkflow(name);
      if (name === OTA_PREVIEW) {
        // Preview runs on every PR synchronization so it can delete a stale
        // branch when the last mobile diff disappears. Its in-job classifier,
        // rather than a trigger paths filter, must retain the fingerprint inputs.
        expect(source, `${name} must react to root patchedDependencies edits`).toContain("path === 'package.json'");
        expect(source, `${name} must react to isolated-linker lock changes`).toContain("path === 'pnpm-lock.yaml'");
        expect(source, `${name} must react to workspace policy changes`).toContain("path === 'pnpm-workspace.yaml'");
        expect(source, `${name} must react to native patch body changes`).toContain("path.startsWith('patches/')");
      } else {
        expect(source, `${name} must react to root patchedDependencies edits`).toContain("- 'package.json'");
        expect(source, `${name} must react to isolated-linker lock changes`).toContain("- 'pnpm-lock.yaml'");
        expect(source, `${name} must react to workspace policy changes`).toContain("- 'pnpm-workspace.yaml'");
        expect(source, `${name} must react to native patch body changes`).toContain("- 'patches/**'");
      }
    }

    expect(readWorkflow(OTA_CHECK), 'OTA compatibility must react to fingerprint config edits').toContain(
      "- 'packages/mobile/**'",
    );
  });

  it('screens root package and fingerprint-config edits inside the composite native gate', () => {
    const nativeGate = readFileSync(NATIVE_GATE, 'utf8');
    const pathScreen = nativeGate.match(/# Path screen:[\s\S]*?# A candidate changed/)?.[0];
    expect(pathScreen, 'mobile-native-gate must retain a candidate-input path screen').toBeTruthy();

    const changedArguments = pathScreen?.match(/\$\(changed \\\n([\s\S]*?)\)" \]; then/)?.[1];
    expect(changedArguments, 'could not read the composite gate changed(...) arguments').toBeTruthy();
    const candidateInputs = changedArguments?.replaceAll('\\', ' ').trim().split(/\s+/) ?? [];

    expect(candidateInputs).toEqual(
      expect.arrayContaining([
        'package.json',
        'packages/mobile/package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'packages/mobile/app.config.ts',
        'packages/mobile/fingerprint.config.js',
        'packages/mobile/plugins',
        'packages/mobile/modules',
        'packages/mobile/locales',
        'packages/mobile/eas.json',
        'packages/mobile/assets',
        'packages/mobile/targets',
        'patches',
      ]),
    );
  });

  it('routes patch-only PRs through the mobile fingerprint and patch sentinels', () => {
    const ci = readWorkflow(CI);
    const mobileFilter = ci.match(/^ {12}mobile:\n(?:^ {14}.*\n)+/m)?.[0];
    expect(mobileFilter, 'ci.yml must retain a mobile paths-filter mapping').toBeTruthy();
    expect(mobileFilter).toContain("- 'patches/**'");

    // Assert the PROPERTY (a patch-only PR reaches both sentinels), not the
    // address. These guards used to live in mobile-bundle and now run in `lint`
    // — they sat in front of Metro and cost ~24s on the critical path. Pinning
    // the assertion to a job name meant a pure relocation reddened CI while the
    // contract still held, so find whichever job hosts each guard and check
    // THAT job is gated on the mobile filter.
    const jobs = [...ci.matchAll(/^ {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/gm)];
    expect(jobs.length, 'ci.yml must parse into jobs').toBeGreaterThan(0);

    for (const guard of ['check:mobile-patches', 'check:mobile-fingerprint-inputs']) {
      const hosts = jobs.filter(([, , body]) => body.includes(`run: vp run ${guard}`));
      expect(hosts.length, `exactly one ci.yml job must run ${guard}`).toBe(1);

      const [, hostName, hostBody] = hosts[0];
      // The JOB-level gate only — four-space indent. Step-level `if:`s sit at
      // eight spaces, and matching one of those instead makes this assertion
      // inert: the lint job already has a step gated on `mobile`, so a loose
      // /if:.*mobile/ passes even after the job gate drops the term.
      const jobGate = hostBody.match(/^ {4}if: (.*)$/m)?.[1] ?? '';
      // Whatever job hosts it must run on a patches-only PR. `mobile` is the
      // only filter term that matches `patches/**`, so its absence would skip
      // the guard on exactly the PR shape it exists for.
      expect(jobGate, `the ${hostName} job runs ${guard}, so its job gate must include the mobile filter`).toContain(
        "needs.changes.outputs.mobile == 'true'",
      );

      // ...and the guard's own step must not re-narrow what the job gate allows.
      const guardStep =
        hostBody.match(new RegExp(`^ {6}- name: [^\\n]*\\n(?: {8}[^\\n]*\\n)*? {8}run: vp run ${guard}$`, 'm'))?.[0] ??
        '';
      expect(guardStep, `the ${guard} step must not carry its own narrowing if:`).not.toMatch(/^ {8}if:/m);
    }
  });

  it('keys the Expo-web Metro cache on its isolated pnpm runtime graph', () => {
    const ci = readWorkflow(CI);
    const nativeCacheStart = ci.indexOf("- name: Restore Metro's native transform cache");
    const webCacheStart = ci.indexOf("- name: Restore Metro's Expo-web transform cache");
    const webCacheEnd = ci.indexOf('\n  docker-web:', webCacheStart);

    expect(nativeCacheStart).toBeGreaterThanOrEqual(0);
    expect(webCacheStart).toBeGreaterThan(nativeCacheStart);
    expect(webCacheEnd).toBeGreaterThan(webCacheStart);

    const nativeCacheSteps = ci.slice(nativeCacheStart, webCacheStart);
    const webCacheSteps = ci.slice(webCacheStart, webCacheEnd);

    for (const runtimeInput of [
      'packages/mobile/web-runtime/pnpm-lock.yaml',
      'packages/mobile/web-runtime/pnpm-workspace.yaml',
    ]) {
      expect(nativeCacheSteps, `native Metro cache must stay independent of ${runtimeInput}`).not.toContain(
        runtimeInput,
      );
      expect(
        webCacheSteps.match(new RegExp(runtimeInput.replaceAll('.', '\\.'), 'g'))?.length ?? 0,
        `all three Expo-web Metro cache keys must include ${runtimeInput}`,
      ).toBe(3);
    }
  });

  it('keys the cached screenshot app on native pnpm policy without lockfile churn', () => {
    const workflow = readWorkflow(MOBILE_SCREENSHOTS_IOS);
    const cacheKeyStep = workflow.split('\n').find((line) => line.includes('screenshot-sim-app-v1-${{ hashFiles('));

    expect(cacheKeyStep, 'mobile screenshot workflow must retain its simulator app cache key').toBeTruthy();
    expect(cacheKeyStep).toContain("'pnpm-workspace.yaml'");
    expect(cacheKeyStep).not.toContain("'pnpm-lock.yaml'");
  });

  it('keys CocoaPods caches on native app images without unrelated asset churn', () => {
    const nativeAppImages = [
      'packages/mobile/assets/icon.png',
      'packages/mobile/assets/adaptive-icon.png',
      'packages/mobile/assets/splash-icon.png',
    ];

    for (const workflowName of [IOS_PR, NATIVE_IOS]) {
      const workflow = readWorkflow(workflowName);
      const cacheKeyStep = workflow.split('\n').find((line) => line.includes('-pods-rn'));

      expect(cacheKeyStep, `${workflowName} must retain its CocoaPods cache key`).toBeTruthy();
      expect(cacheKeyStep).not.toContain("'packages/mobile/assets/**'");
      for (const nativeAppImage of nativeAppImages) {
        expect(cacheKeyStep, `${workflowName} must invalidate Pods when ${nativeAppImage} changes`).toContain(
          `'${nativeAppImage}'`,
        );
      }
    }
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

// The per-PR preview publish (mobile-ota-preview.yml) + its sweep
// (mobile-ota-preview-sweep.yml) ship and reap `pr-<number>` branches on the same
// store binary + S3 bucket as production. The fingerprint-env parity above already
// guards delivery; these guard the security boundary (never touch production) and
// the cleanup boundary (the branch name's prefix must equal the S3 lifecycle
// prefix, or previews never expire).
const OTA_PREVIEW_SWEEP = 'mobile-ota-preview-sweep.yml';
const OTA_PREVIEW_PROMPT = 'mobile-ota-preview-prompt.yml';

describe('mobile OTA preview branch isolation + S3 lifecycle coupling', () => {
  it('opts every dependency-free TypeScript cleanup into Node type stripping', () => {
    const cleanupCommand = 'node --experimental-strip-types scripts/ota-preview-cleanup.ts delete --branch';

    expect(readWorkflow(OTA_PREVIEW)).toContain(`${cleanupCommand} "$BRANCH"`);
    expect(readWorkflow(OTA_PREVIEW_PROMPT).match(new RegExp(cleanupCommand, 'g'))?.length ?? 0).toBe(2);
    expect(readWorkflow(OTA_PREVIEW_SWEEP)).toContain(`${cleanupCommand} "$name"`);
  });

  it('runs fork reconciliation from trusted pull_request_target metadata only', () => {
    const prompt = readWorkflow(OTA_PREVIEW_PROMPT);
    expect(prompt).toMatch(/^\s+pull_request_target:/m);
    expect(prompt).not.toMatch(/^\s+workflow_run:/m);
    expect(prompt).not.toContain('actions/download-artifact');
    expect(prompt).not.toContain('actions/upload-artifact');
    expect(prompt).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(prompt).not.toContain('ref: ${{ github.event.pull_request.head.sha }}');
  });

  it('reconciles every PR revision in one per-PR lifecycle lane', () => {
    const preview = readWorkflow(OTA_PREVIEW);
    const triggerBlock = preview.match(/^on:[\s\S]*?^permissions:/m)?.[0] ?? '';

    // A paths filter would suppress the synchronization that removes the final
    // mobile file, leaving the previous preview live indefinitely.
    expect(triggerBlock).not.toMatch(/^\s+paths:/m);
    expect(preview).toContain('github.paginate(github.rest.pulls.listFiles');
    expect(preview).toContain("mobileChanges ? 'publish' : 'cleanup'");
    expect(preview).toContain('mobile-ota-preview-lifecycle-${{');
    expect(preview).toContain("github.event.comment.body == '/ota-preview'");
    expect(preview).toContain('github.run_id }}');
    expect(preview).not.toMatch(/^\s*cancel-in-progress:\s*true$/m);
    expect(readWorkflow(OTA_PREVIEW_PROMPT)).not.toMatch(/^\s*cancel-in-progress:\s*true$/m);
    expect(preview).not.toContain('mobile-ota-preview-publish-');
    expect(preview).not.toContain('mobile-ota-preview-cleanup-');
  });

  it('resets a mutable preview branch before publishing the current compatible platforms', () => {
    const preview = readWorkflow(OTA_PREVIEW);
    const resetOffset = preview.indexOf('\n  reset:');
    const publishOffset = preview.indexOf('\n  publish:');

    expect(resetOffset).toBeGreaterThan(0);
    expect(publishOffset).toBeGreaterThan(resetOffset);
    expect(preview).toMatch(/^  publish:\n\s+needs: \[gate, reset\]/m);
    expect(preview).toContain("['legacy channel', `/api/apps/${appId}/channels/${encoded}`]");
    expect(preview).toContain("['branch', `/api/apps/${appId}/branches/${encoded}`]");
  });

  it('authorizes comments before dispatching them into the trusted PR lifecycle lane', () => {
    const preview = readWorkflow(OTA_PREVIEW);
    expect(preview).toContain('github.rest.repos.getCollaboratorPermissionLevel');
    expect(preview).toContain("['admin', 'maintain', 'write'].includes(permission.permission)");
    expect(preview).not.toContain('context.payload.comment.author_association');
    expect(preview).toContain("const isCommand = body === '/ota-preview';");
    expect(preview).toContain("const body = context.payload.comment.body || '';");
    expect(preview).toContain('github.rest.actions.createWorkflowDispatch');
    expect(preview).toContain("workflow_id: 'mobile-ota-preview.yml'");
    expect(preview).toContain('ref: context.payload.repository.default_branch');
    expect(preview).toContain('core.notice(`Authorized /ota-preview for PR #${prNumber}; queued trusted dispatch.`)');
    expect((preview.match(/group: mobile-ota-preview-mutation-/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('reconciles trusted fork metadata from authoritative full-SHA deployment state', () => {
    const prompt = readWorkflow(OTA_PREVIEW_PROMPT);
    const preview = readWorkflow(OTA_PREVIEW);
    expect(prompt).toContain('if: github.event.pull_request.head.repo.full_name != github.repository');
    expect(prompt).toContain("core.setOutput('head_sha', pr.head.sha)");
    expect(prompt).toContain('github.paginate(github.rest.pulls.listFiles');
    expect(prompt).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(prompt).toContain(
      'node --experimental-strip-types scripts/ota-preview-cleanup.ts delete --branch "$BRANCH"',
    );
    expect(prompt).toContain('group: mobile-ota-preview-mutation-${{ needs.inspect.outputs.pr_number }}');

    const currentHeadCheck = prompt.indexOf('Check whether this head is already reconciled');
    const deletePrevious = prompt.indexOf('Remove previous fork preview revision');
    expect(currentHeadCheck).toBeGreaterThan(0);
    expect(deletePrevious).toBeGreaterThan(currentHeadCheck);
    expect(prompt).toContain("if: steps.published.outputs.current != 'true'");
    expect(prompt).toContain('deployment.ref === process.env.HEAD_SHA');
    expect(prompt).toContain("deployment.creator?.login === 'github-actions[bot]'");
    expect(prompt).toContain('github.rest.repos.listDeploymentStatuses');
    expect(preview).toContain('Finalize authoritative deployment state');
    expect(preview).toContain('GitHub did not return the authoritative preview deployment id.');
    expect(preview).not.toContain('Deployment is a visibility nicety');
    expect(preview).toContain("comment.user?.login === 'github-actions[bot]'");
    expect(prompt).toContain("comment.user?.login === 'github-actions[bot]'");
  });

  it('reconciles sticky comments and deployments when a preview becomes pending or removed', () => {
    const preview = readWorkflow(OTA_PREVIEW);
    const prompt = readWorkflow(OTA_PREVIEW_PROMPT);
    expect(preview).toContain("const promptMarker = '<!-- mobile-ota-preview-prompt -->';");
    expect(preview).toContain('candidate.description === `OTA preview ${branch}`');
    expect(preview).toContain("const reasonText = reason === 'closed'");
    expect(prompt).toContain('candidate.description === `OTA preview ${branch}`');
    expect(prompt).toContain('waiting for a maintainer publish');
    expect(prompt).toContain('this fork PR no longer changes mobile');
  });

  it('fails the scheduled sweep on unavailable or malformed inventories', () => {
    const sweep = readWorkflow(OTA_PREVIEW_SWEEP);
    expect(sweep).toContain('Could not list open PRs — refusing to sweep');
    expect(sweep).toContain('Could not list channels from the V3 server — refusing to sweep');
    expect(sweep).toContain('Could not list branches from the V3 server — refusing to sweep');
    expect(sweep).toContain('Channel inventory had an unexpected shape — refusing to sweep');
    expect(sweep).toContain('Branch inventory had an unexpected shape — refusing to sweep');
    expect(sweep).toMatch(/Could not list open PRs[^\n]*\n\s*exit 1/);
  });

  it('carries the compat fingerprints through to the preview comment', () => {
    // A pr-<n> branch is offered only to a binary whose runtimeVersion matches it
    // EXACTLY. When a native change lands on main, every un-rebased PR keeps the old
    // fingerprint, its publish is skipped, and the tester's picker silently empties.
    // Naming both hashes on the PR is what makes that visible, so keep the chain
    // wired: the check emits them, the job forwards them, the comment prints them.
    const check = readFileSync(resolve(REPO_ROOT, 'scripts/mobile-ota-compat-check.ts'), 'utf8');
    const preview = readWorkflow(OTA_PREVIEW);
    for (const platform of ['ios', 'android']) {
      expect(check, `compat check must emit fingerprint_${platform}`).toContain(`\`fingerprint_${platform}=`);
      expect(check, `compat check must emit base_fingerprint_${platform}`).toContain(`\`base_fingerprint_${platform}=`);
      expect(preview).toContain(`fingerprint_${platform}: \${{ steps.compat.outputs.fingerprint_${platform} }}`);
      expect(preview).toContain(
        `FINGERPRINT_${platform.toUpperCase()}: \${{ needs.publish.outputs.fingerprint_${platform} }}`,
      );
    }
    expect(preview).toContain('| Platform | Status | Fingerprint |');
    // Two unresolved hashes compare equal; saying "matches main" there would
    // invent a reassurance out of a failed resolve.
    expect(preview).toContain("if (mine === '—') return '`—` (unresolved)';");
  });

  it('tells "adds native code" apart from "behind a native change on main"', () => {
    // The two need opposite fixes — a store build vs a rebase — so the skip must not
    // give one message. Containment is the free signal: origin/main is already
    // fetched for the baseline worktree.
    const preview = readWorkflow(OTA_PREVIEW);
    expect(preview).toContain('git merge-base --is-ancestor origin/main HEAD');
    expect(preview).toContain('behind_main: ${{ steps.behind.outputs.behind_main }}');
    // Three-valued on purpose. --is-ancestor exits >1 on a real error, and folding
    // that into "not contained" would tell a genuinely native PR to rebase — the
    // opposite of what it needs. Only the literal 'true' claims the PR is behind.
    expect(preview).toContain('*) behind=unknown');
    expect(preview).toContain("const behindMain = process.env.BEHIND_MAIN === 'true';");
    // Worded as "rebase, then re-check", not "rebase to fix": a PR can be behind
    // main AND add native code of its own, and containment cannot separate those
    // without a third fingerprint resolve. Promising a rebase is sufficient would
    // be wrong in that overlap.
    expect(preview).toContain('behind a native change on `main` — rebase, then re-check');
    expect(preview).toContain('needs a TestFlight/Play build');
  });

  it('lists the sweep inventory with the dashboard admin session, not the eoo_ key', () => {
    // xprem guards GET /channels and GET /branches with AnyViewer(), which an
    // app-scoped eoo_ key does not satisfy. It answers 403, and because the sweep
    // fails closed that turned every scheduled run red from 2026-09-01. The step
    // already mints an admin session for the DELETE; both LISTs reuse it.
    const sweep = readWorkflow(OTA_PREVIEW_SWEEP);
    expect(sweep).toContain(`ADMIN_TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -r '.token')"`);
    expect(sweep).toMatch(/Authorization: Bearer \$ADMIN_TOKEN/);
    expect(sweep, 'the eoo_ key cannot read these routes — it must not come back').not.toContain('EOO_TOKEN');
    expect(sweep, 'Use-Cli-Auth was the eoo_ escape hatch that stopped working').not.toContain('Use-Cli-Auth');
  });

  it('publishes the preview to a pr-<number> branch, never production', () => {
    const preview = readWorkflow(OTA_PREVIEW);
    expect(preview).toMatch(/--channel "\$BRANCH" --platform ios/);
    expect(preview).toMatch(/--channel "\$BRANCH" --platform android/);
    expect(preview).not.toMatch(/^  map:/m);
  });

  it('guards every branch mutation behind ^pr-[1-9][0-9]*$', () => {
    // Defense-in-depth: even if the resolved branch were wrong, the publish,
    // cleanup, and sweep all refuse anything that isn't a numeric PR branch — so
    // none of them can ever delete or overwrite `production`.
    const preview = readWorkflow(OTA_PREVIEW);
    const sweep = readWorkflow(OTA_PREVIEW_SWEEP);
    // publish-side assert + cleanup-side assert.
    expect((preview.match(/\^pr-\[1-9\]\[0-9\]\*\$/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(sweep).toMatch(/\^pr-\[1-9\]\[0-9\]\*\$/);
  });

  it('scopes the S3 lifecycle prefix to <appId>/pr- (ends with the branch prefix, and documented)', () => {
    // V3 (control-plane) keys updates as <appId>/<branch>/<rtv>/<ts>/…, so the S3
    // lifecycle rule that bounds per-PR preview storage is scoped to `<appId>/pr-`
    // — NOT a bare `pr-`. It MUST end with the workflow's branch-name prefix (so
    // it matches only pr-<n> branches) and can never match `<appId>/production/…`.
    // The branch-name prefix and the S3 key prefix differ, so they're two
    // constants in mobile-ota-setup.ts; if they drift, previews either never expire
    // (storage leak) or the rule hits production. The docs must document the exact
    // appId-scoped prefix.
    const preview = readWorkflow(OTA_PREVIEW);
    const guard = preview.match(/\^(pr-)\[1-9\]\[0-9\]\*\$/);
    expect(guard, 'preview workflow must guard branches as ^pr-[1-9][0-9]*$').not.toBeNull();
    const branchPrefix = guard![1];

    const setup = readFileSync(resolve(REPO_ROOT, 'scripts/mobile-ota-setup.ts'), 'utf8');
    const appId = setup.match(/OTA_APP_ID\s*=\s*'([^']+)'/)?.[1];
    const branchConst = setup.match(/PREVIEW_BRANCH_PREFIX\s*=\s*'([^']+)'/)?.[1];
    expect(appId, 'setup must define OTA_APP_ID').toBeTruthy();
    expect(branchConst, 'setup PREVIEW_BRANCH_PREFIX must equal the workflow branch prefix').toBe(branchPrefix);
    // Guard the DEFINITION, not a value we reconstruct: PREVIEW_S3_PREFIX must be
    // composed as `${OTA_APP_ID}/${PREVIEW_BRANCH_PREFIX}`. A hardcoded rewrite
    // (e.g. 'previews/') that stopped matching pr- keys would then fail here instead
    // of silently leaking preview storage.
    expect(setup, 'PREVIEW_S3_PREFIX must be composed from OTA_APP_ID + PREVIEW_BRANCH_PREFIX').toMatch(
      /PREVIEW_S3_PREFIX\s*=\s*`\$\{OTA_APP_ID\}\/\$\{PREVIEW_BRANCH_PREFIX\}`/,
    );
    const s3Prefix = `${appId}/${branchConst}`;
    expect(s3Prefix.endsWith(branchPrefix), 'the composed S3 prefix must end with the branch-name prefix').toBe(true);

    const docs = readFileSync(resolve(REPO_ROOT, 'docs/mobile-ota-updates.md'), 'utf8');
    expect(docs.toLowerCase(), 'docs must describe the S3 lifecycle rule').toContain('lifecycle');
    expect(docs, `docs must document the appId-scoped lifecycle prefix \`${s3Prefix}\``).toContain(s3Prefix);
  });

  it('keeps the OTA app id identical across app.config, the shared const, cleanup, setup, and the doctor', () => {
    // The expo-app-id header is baked by app.config.ts (inline — Expo's config loader
    // can't import a sibling .ts) and mirrored in src/lib/ota-app-id.ts for the EAS
    // preview-build switcher; the cleanup helper (DEFAULT_APP_ID), the setup runbook and
    // the surf doctor (OTA_APP_ID) address the same app. A drift 404s ("Unknown app id")
    // or mis-routes previews, and the id is a fingerprint input — so pin all five equal.
    // They stay literals rather than one shared import because ota-preview-cleanup.ts
    // runs under bare `node --experimental-strip-types` with no install step, and
    // app.config.ts is read by a loader that cannot resolve a sibling .ts.
    const idFrom = (rel: string, name: string): string | undefined => {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      return (
        src.match(new RegExp(`${name}\\s*=\\s*process\\.env\\.[A-Z_]+\\s*\\?\\?\\s*'([0-9a-fA-F-]+)'`))?.[1] ??
        src.match(new RegExp(`${name}\\s*=\\s*'([0-9a-fA-F-]+)'`))?.[1]
      );
    };
    const shared = idFrom('packages/mobile/src/lib/ota-app-id.ts', 'OTA_APP_ID');
    expect(shared, 'src/lib/ota-app-id must define OTA_APP_ID').toBeTruthy();
    expect(idFrom('packages/mobile/app.config.ts', 'OTA_APP_ID'), 'app.config OTA_APP_ID').toBe(shared);
    expect(idFrom('scripts/ota-preview-cleanup.ts', 'DEFAULT_APP_ID'), 'ota-preview-cleanup DEFAULT_APP_ID').toBe(
      shared,
    );
    expect(idFrom('scripts/mobile-ota-setup.ts', 'OTA_APP_ID'), 'mobile-ota-setup OTA_APP_ID').toBe(shared);
    expect(idFrom('scripts/mobile-ota-surf-doctor.ts', 'OTA_APP_ID'), 'mobile-ota-surf-doctor OTA_APP_ID').toBe(shared);
  });

  it('uses pull_request (never pull_request_target) so fork jobs get no secrets', () => {
    // pull_request_target would run PR-author code with the production-capable
    // EOO_TOKEN — the exact thing this design forbids. Match the YAML trigger key
    // (a comment may legitimately name the anti-pattern to warn against it).
    const preview = readWorkflow(OTA_PREVIEW);
    expect(preview).toMatch(/^on:/m);
    expect(preview).toMatch(/^\s+pull_request:/m);
    expect(preview).not.toMatch(/^\s*pull_request_target:/m);
  });

  it('scopes the token-bearing publish to the ota-preview environment', () => {
    // The publish job runs PR-author code with EOO_TOKEN, so the secret stays
    // environment-scoped. Fork authorization is enforced separately above.
    const preview = readWorkflow(OTA_PREVIEW);
    expect(preview).toMatch(/^\s+environment:\s*ota-preview\s*$/m);
  });

  it('sets GOOGLE_MAPS_API_KEY only on the Android preview publish', () => {
    // Same per-platform split as production: iOS resolves without the key (Apple
    // Maps), Android with it — so each platform's published fingerprint matches its
    // binary. Exactly one occurrence ⇒ scoped to the Android step.
    const preview = readWorkflow(OTA_PREVIEW);
    expect(preview).toMatch(/GOOGLE_MAPS_API_KEY:\s*\$\{\{\s*secrets\.GOOGLE_MAPS_API_KEY\s*\}\}/);
    expect((preview.match(/GOOGLE_MAPS_API_KEY:/g) ?? []).length).toBe(1);
  });
});
