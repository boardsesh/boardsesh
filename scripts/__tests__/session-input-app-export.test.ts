import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  inspectCachedSimulatorApp,
  SESSION_INPUT_APP_CACHE,
  SESSION_INPUT_NATIVE_HASHES,
  sha256,
} from '../lib/session-input-observation/cached-app';

const directories: string[] = [];
const nativeFiles = {
  Boardsesh: Buffer.from('fixture-executable'),
  'Boardsesh.debug.dylib': Buffer.from('fixture-debug'),
};
const expectedHashes = Object.fromEntries(Object.entries(nativeFiles).map(([name, bytes]) => [name, sha256(bytes)]));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), '7154-app-export-'));
  directories.push(directory);
  const app = join(directory, 'Boardsesh.app');
  mkdirSync(app);
  const write = (resource: string, content: string | Buffer) => {
    const path = join(app, resource);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  write(
    'Info.plist',
    JSON.stringify({
      CFBundleIdentifier: 'com.boardsesh.app',
      CFBundleExecutable: 'Boardsesh',
      DTSDKName: 'iphonesimulator26.5',
      DTXcodeBuild: '17F113',
    }),
  );
  for (const [name, bytes] of Object.entries(nativeFiles)) write(name, bytes);
  chmodSync(join(app, 'Boardsesh'), 0o755);
  write(
    'EXConstants.bundle/app.config',
    JSON.stringify({
      extra: { eas: { projectId: 'public-id' }, router: {}, tailscaleHosts: [] },
      updates: { codeSigningCertificate: '-----BEGIN CERTIFICATE-----public-----END CERTIFICATE-----' },
      plugins: [['public-config', { dsn: 'https://public-client@sentry.example/1', clientId: 'public-client-id' }]],
    }),
  );
  return { app, write, inspect: () => inspectCachedSimulatorApp(app, expectedHashes) };
}
afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe('cached CI build-product export inventory', () => {
  it('accepts public native config, dependency scripts and the known share preprocessor without changing bytes or modes', () => {
    const app = fixture();
    app.write('EXDevMenu.bundle/tools.js', 'const password = "code-constant";');
    app.write('PlugIns/BoardseshBeta.appex/ShareExtensionPreprocessor.js', 'const password = "code-constant";');
    const before = readFileSync(join(app.app, 'Boardsesh'));
    const inventory = app.inspect();
    expect(inventory.safe).toBe(true);
    expect(inventory.files.find((file) => file.path === 'Boardsesh')).toMatchObject({
      mode: 0o755,
      sha256: expectedHashes.Boardsesh,
    });
    expect(readFileSync(join(app.app, 'Boardsesh'))).toEqual(before);
    expect(JSON.stringify(inventory)).not.toContain('public-client-id');
    expect(inventory.configurationKeys.find((config) => config.path.endsWith('app.config'))?.keys).toContain(
      'extra.eas.projectId',
    );
  });
  it.each(['main.jsbundle', 'main.js', 'index.hbc', 'bundle.hermes', 'unlabelled-resource'])(
    'rejects application-owned JS/Hermes: %s',
    (resource) => {
      const app = fixture();
      app.write(
        resource,
        resource === 'unlabelled-resource' ? Buffer.from('c61fbc03c103191f', 'hex') : 'application payload',
      );
      expect(app.inspect().failures).toContain(`embedded_application_javascript:${resource}`);
    },
  );
  it.each([
    '.env',
    '.env.production',
    'embedded.mobileprovision',
    'signing.p8',
    'private.key',
    'export.p12',
    'state.sqlite',
    'Documents/account.json',
    'Library/keychain',
    'Caches/cache.bin',
  ])('rejects credential or runtime resources: %s', (resource) => {
    const app = fixture();
    app.write(resource, 'must-never-be-exported');
    const inventory = app.inspect();
    expect(inventory.safe).toBe(false);
    expect(inventory.failures.some((failure) => failure.startsWith('runtime_or_private_resource:'))).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain('must-never-be-exported');
  });
  it('rejects escaping symlinks but inventories internal framework links', () => {
    const app = fixture();
    symlinkSync('Boardsesh', join(app.app, 'internal'));
    expect(app.inspect().safe).toBe(true);
    symlinkSync('/private/tmp', join(app.app, 'escape'));
    expect(app.inspect().failures).toContain('escaping_symlink:escape');
  });
  it.each([
    { extra: { devMetadata: { qaNotes: 'private text' } } },
    { api_token: 'private-token' },
    { password: 'private-password' },
    { endpoint: 'https://user:private-password@example.test' },
  ])('rejects unexpected/private configuration without retaining its values', (configuration) => {
    const app = fixture();
    app.write('EXConstants.bundle/app.config', JSON.stringify(configuration));
    const inventory = app.inspect();
    expect(inventory.safe).toBe(false);
    expect(JSON.stringify(inventory)).not.toMatch(/private text|private-token|private-password/);
  });
  it('requires the exact native identities, including the original SDK', () => {
    const app = fixture();
    expect(inspectCachedSimulatorApp(app.app).failures).toContain('native_hash_mismatch:Boardsesh.debug.dylib');
    app.write(
      'Info.plist',
      JSON.stringify({
        CFBundleIdentifier: 'com.boardsesh.app',
        CFBundleExecutable: 'Boardsesh',
        DTSDKName: 'iphonesimulator27.1',
      }),
    );
    expect(app.inspect().failures).toContain('native_app_identity_or_sdk_mismatch');
    expect(SESSION_INPUT_NATIVE_HASHES['Boardsesh.debug.dylib']).toBe(
      '2890913dc555fbe4bdeab6f694a4f79255ea3dacdd93331d0dba8e0d84a67e5d',
    );
  });
});

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { if?: string; 'timeout-minutes'?: number; steps?: Step[] };
const workflow = () =>
  parse(readFileSync('.github/workflows/mobile-store-videos-measure.yml', 'utf8')) as { jobs: Record<string, Job> };
describe('exclusive cache-only diagnostic workflow', () => {
  it('runs only export-app, with an exact fail-on-miss restore and no native/runtime/auth operation', () => {
    const jobs = workflow().jobs;
    const evaluate = (expression = 'true') =>
      runInNewContext(expression, { inputs: { mode: 'export-session-input-app' }, always: () => true });
    expect(
      Object.entries(jobs)
        .filter(([, job]) => evaluate(job.if))
        .map(([name]) => name),
    ).toEqual(['export-app']);
    const job = jobs['export-app'];
    expect(job['timeout-minutes']).toBe(10);
    const restore = job.steps?.find((step) => step.uses === 'actions/cache/restore@v4');
    expect(restore?.with).toEqual({
      path: 'packages/mobile/.app-cache',
      key: SESSION_INPUT_APP_CACHE,
      'fail-on-cache-miss': true,
    });
    expect(JSON.stringify(job)).not.toMatch(
      /secrets\.|vp install|mobile:build|simctl|maestro|expo start|video:record|cache\/save|screenshot-backend/i,
    );
    expect(job.steps?.find((step) => step.id === 'inspect')?.run).toBe(
      'node --experimental-strip-types scripts/export-session-input-app.ts',
    );
  });
  it('uploads the archive only after inspection and keeps rejected inventory separate for one day', () => {
    const uploads =
      workflow().jobs['export-app'].steps?.filter((step) => step.uses === 'actions/upload-artifact@v4') ?? [];
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toMatchObject({
      if: 'always()',
      with: { path: '.boardsesh/session-input-app-export/metadata/', 'retention-days': 1 },
    });
    expect(uploads[1]).toMatchObject({
      if: "steps.inspect.outputs.safe == 'true'",
      with: { path: '.boardsesh/session-input-app-export/binary/Boardsesh-ci-sdk26_5.tar.gz', 'retention-days': 1 },
    });
    const exporter = readFileSync('scripts/export-session-input-app.ts', 'utf8');
    expect(exporter).toContain('if (!receipt.cacheHit || receipt.cacheKey !== SESSION_INPUT_APP_CACHE)');
    expect(exporter.indexOf('if (!inventory.safe)')).toBeLessThan(exporter.indexOf("spawnSync('tar'"));
    expect(exporter.indexOf('source_app_changed_during_archive')).toBeLessThan(exporter.indexOf("'safe=true\\n'"));
    expect(exporter).not.toMatch(/--sign|installApp|launchApp|keychain|process\.env\.[A-Z_]*(?:PASSWORD|TOKEN|EMAIL)/);
  });
});
