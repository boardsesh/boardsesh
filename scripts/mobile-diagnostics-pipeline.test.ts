import { describe, expect, it } from 'vitest';
import {
  parseSentryElfDebugId,
  parseElfDiagnostics,
  matchOwnedElf,
  assertPackagedOwnedLibraries,
  OWNED_ANDROID_LIBRARIES,
} from './mobile-upload-android-symbols';
import { assertMatchingMachOUuids, parseMachOUuids } from './mobile-upload-dsyms';
import { validateEmbeddedDebugId } from './mobile-upload-embedded-sourcemaps';
import { auditNativeDiagnosticEvent } from './mobile-diagnostics-audit';

describe('native artifact gates', () => {
  it('requires usable Sentry DWARF for the packaged ELF code ID', () => {
    const checked = {
      type: 'elf',
      is_usable: true,
      features: 'debug, unwind',
      variants: [{ debug_id: 'test-id', code_id: 'abc123' }],
    };
    expect(parseSentryElfDebugId(JSON.stringify(checked), 'abc123')).toBe('test-id');
    expect(() => parseSentryElfDebugId(JSON.stringify({ ...checked, features: 'symtab, unwind' }), 'abc123')).toThrow(
      'usable DWARF',
    );
    expect(() => parseSentryElfDebugId(JSON.stringify(checked), 'different-build')).toThrow('usable DWARF');
  });
  it('requires every owned ELF in every ABI of each actual archive', () => {
    const entries = OWNED_ANDROID_LIBRARIES.map((name) => ({ name, abi: 'arm64-v8a' }));
    expect(() => assertPackagedOwnedLibraries('app-release.aab', entries)).not.toThrow();
    expect(() => assertPackagedOwnedLibraries('app-release.aab', entries.slice(1))).toThrow(
      'absent from app-release.aab',
    );
    expect(() =>
      assertPackagedOwnedLibraries('app-release.apk', [...entries, { name: 'libvendor.so', abi: 'x86_64' }]),
    ).toThrow('x86_64');
  });
  it('rejects a stripped symbol candidate or an architecture/build mismatch', () => {
    const packaged = { name: 'libboard_renderer_jni.so', abi: 'arm64-v8a', buildId: 'abc123' };
    const candidate = {
      path: '/symbols/libboard_renderer_jni.so',
      abi: 'arm64-v8a',
      buildId: 'abc123',
      hasDwarf: true,
    };
    expect(matchOwnedElf(packaged, [candidate])).toBe(candidate.path);
    for (const changed of [{ hasDwarf: false }, { abi: 'x86_64' }, { buildId: 'deadbeef' }])
      expect(() => matchOwnedElf(packaged, [{ ...candidate, ...changed }])).toThrow('No matching DWARF');
    expect(() => parseElfDiagnostics('.debug_info')).toThrow('build ID');
    expect(parseElfDiagnostics('Build ID: abC123\n .debug_info')).toEqual({ buildId: 'abc123', hasDwarf: true });
  });
  it('requires a matching UUID for every shipped Mach-O architecture', () => {
    const arm = parseMachOUuids('UUID: 11111111-1111-1111-1111-111111111111 (arm64) /app');
    const intel = parseMachOUuids('UUID: 11111111-1111-1111-1111-111111111111 (x86_64) /app');
    expect(() => assertMatchingMachOUuids(arm, arm)).not.toThrow();
    expect(() => assertMatchingMachOUuids(arm, intel)).toThrow('UUID/architecture');
    expect(() => assertMatchingMachOUuids([], arm)).toThrow();
  });
});
describe('native crash evidence audit', () => {
  const event = {
    exception: { values: [{ type: 'SIGABRT', mechanism: { type: 'TombstoneMerged' } }] },
    threads: {
      values: [
        {
          crashed: true,
          stacktrace: { frames: [{ function: 'boardsesh_test_abort', filename: 'renderer_jni.cpp', lineno: 42 }] },
        },
      ],
    },
    debug_meta: { images: [{ debug_id: 'owned-build-id' }] },
    contexts: { diagnostics: { launchId: 'test-launch' } },
    tags: { source: 'sentry-test', test_run_id: 'test-run', ota_update_id: 'running-update', ota_is_embedded: 'false' },
    attachments: [{ name: 'tombstone.txt', size: 1024 }],
  };
  it('accepts owned source evidence and rejects system-only aborts', () => {
    expect(
      auditNativeDiagnosticEvent(event, 'android', true, {
        testRunId: 'test-run',
        launchId: 'test-launch',
        updateId: 'running-update',
        embedded: false,
      }),
    ).toEqual([]);
    expect(
      auditNativeDiagnosticEvent({ event, attachments: event.attachments }, 'android', true, {
        testRunId: 'wrong-run',
        updateId: 'new-next-launch-update',
        embedded: true,
      }),
    ).toHaveLength(3);
    expect(
      auditNativeDiagnosticEvent(
        {
          ...event,
          threads: { values: [{ crashed: true, stacktrace: { frames: [] } }] },
          exception: {
            values: [
              {
                type: 'SIGABRT',
                stacktrace: { frames: [{ function: 'boardsesh_abort', filename: 'renderer_jni.cpp', lineno: 42 }] },
              },
            ],
          },
        },
        'android',
      ),
    ).toContain('No owned frame symbolicated to a source line.');
    expect(auditNativeDiagnosticEvent({ ...event, threads: { values: [] } }, 'android', true)).toContain(
      'No identified crashing thread.',
    );
    expect(auditNativeDiagnosticEvent({ ...event, debug_meta: {} }, 'ios')).toContain('No native debug image IDs.');
    expect(auditNativeDiagnosticEvent({ ...event, attachments: [] }, 'android', true)).toContain(
      'Android event has no nonempty raw tombstone attachment metadata.',
    );
  });
});

describe('packaged source map gate', () => {
  const debugId = '11111111-1111-1111-1111-111111111111';
  it('requires the declared map ID in the actual packaged bytes', () => {
    expect(validateEmbeddedDebugId(Buffer.from(`Hermes ${debugId}`), { debug_id: debugId })).toBe(debugId);
    expect(() => validateEmbeddedDebugId(Buffer.from('stale bundle'), { debug_id: debugId })).toThrow(
      'matching Debug ID',
    );
    expect(() => validateEmbeddedDebugId(Buffer.from(debugId), {})).toThrow('matching Debug ID');
  });
});

describe('native publication ordering', () => {
  it('gates store publication on actual archive bundles and native inventory', async () => {
    const { readFileSync } = await import('node:fs');
    const android = readFileSync(new URL('../.github/workflows/android-apk-rn.yml', import.meta.url), 'utf8');
    const ios = readFileSync(new URL('../.github/workflows/ios-testflight-rn.yml', import.meta.url), 'utf8');
    expect(android.indexOf('- name: Validate and upload AAB embedded source maps')).toBeLessThan(
      android.indexOf('id: play_upload'),
    );
    expect(android.indexOf('- name: Upload Android native symbols')).toBeLessThan(android.indexOf('id: play_upload'));
    expect(android).toContain('unzip -p "$aab_path" base/assets/index.android.bundle');
    expect(android).toContain('cmp "$bundle_path" "$packaged_bundle"');
    expect(ios.indexOf('- name: Validate and upload embedded iOS source maps')).toBeLessThan(
      ios.indexOf('id: testflight_upload'),
    );
    expect(ios).toContain('COMPOSE_SOURCEMAP_PATH:');
    expect(ios).toContain('SENTRY_DISABLE_AUTO_UPLOAD=true');
  });
});
