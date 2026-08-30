/// <reference types="node" />

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEasUpdateArgs, buildSelfHostedEoasArgs } from './mobile-publish';
import {
  createSentryUploadEnvironment,
  parseUploadArgs,
  resolveInstalledSentryUploader,
  uploadMobileSourceMaps,
  validateSourceMapOutput,
  type MobilePlatform,
} from './mobile-upload-sourcemaps';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALID_DEBUG_ID = '12345678-1234-4abc-9def-1234567890ab';
const createdDirectories: string[] = [];

// The repo's Next global.d.ts augments NodeJS.ProcessEnv to require NODE_ENV, so
// the partial env fixtures below need the assertion to be assignable.
function processEnv(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

interface MobileFixture {
  mobileDir: string;
  outputDir: string;
  bundlePath: string;
  sourceMapPath: string;
  relativeBundlePath: string;
}

function createMobileFixture(platform: MobilePlatform = 'ios', bundleExtension: 'hbc' | 'js' = 'hbc'): MobileFixture {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'boardsesh-mobile-sourcemaps-test-')));
  createdDirectories.push(fixtureRoot);
  const mobileDir = join(fixtureRoot, 'mobile');
  const outputDir = join(mobileDir, 'dist');
  const relativeBundlePath = `_expo/static/js/${platform}/entry-test.${bundleExtension}`;
  const bundlePath = join(outputDir, relativeBundlePath);
  const sourceMapPath = `${bundlePath}.map`;
  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(join(mobileDir, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(bundlePath, 'hermes bytecode');
  writeFileSync(
    sourceMapPath,
    JSON.stringify({ version: 3, sources: ['../../src/example.ts'], mappings: '', debugId: VALID_DEBUG_ID }),
  );
  writeFileSync(
    join(outputDir, 'metadata.json'),
    JSON.stringify({
      version: 0,
      bundler: 'metro',
      fileMetadata: { [platform]: { bundle: relativeBundlePath, assets: [] } },
    }),
  );
  return { mobileDir, outputDir, bundlePath, sourceMapPath, relativeBundlePath };
}

function rewriteMetadata(fixture: MobileFixture, fileMetadata: Record<string, unknown>): void {
  writeFileSync(
    join(fixture.outputDir, 'metadata.json'),
    JSON.stringify({ version: 0, bundler: 'metro', fileMetadata }),
  );
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function listRelativeFiles(directoryPath: string, relativeDirectory = ''): string[] {
  return readdirSync(join(directoryPath, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);
    return entry.isDirectory() ? listRelativeFiles(directoryPath, relativePath) : [relativePath];
  });
}

function workflowStep(workflow: string, name: string): string {
  const stepStart = workflow.indexOf(`      - name: ${name}`);
  expect(stepStart, `Missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);
  const nextStep = workflow.indexOf('\n      - ', stepStart + 1);
  return workflow.slice(stepStart, nextStep === -1 ? undefined : nextStep);
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directoryPath = createdDirectories.pop();
    if (directoryPath) rmSync(directoryPath, { recursive: true, force: true });
  }
});

describe('OTA source-map artifact validation', () => {
  it.each(['hbc', 'js'] as const)('accepts a complete requested-platform %s bundle with a Debug ID', (extension) => {
    const fixture = createMobileFixture('ios', extension);
    expect(validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'ios')).toEqual([
      {
        bundlePath: fixture.bundlePath,
        sourceMapPath: fixture.sourceMapPath,
        relativeBundlePath: fixture.relativeBundlePath,
        relativeSourceMapPath: `${fixture.relativeBundlePath}.map`,
        debugId: VALID_DEBUG_ID,
      },
    ]);
  });

  it('requires an output directory and Expo Metro metadata', () => {
    const fixture = createMobileFixture('ios');
    expect(() => validateSourceMapOutput(fixture.mobileDir, join(fixture.mobileDir, 'missing'), 'ios')).toThrow(
      'output directory does not exist',
    );

    writeFileSync(
      join(fixture.outputDir, 'metadata.json'),
      JSON.stringify({ version: 1, bundler: 'other', fileMetadata: {} }),
    );
    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'ios')).toThrow(
      'Expo Metro metadata version 0',
    );
  });

  it('requires metadata.json to contain exactly the requested platform', () => {
    const fixture = createMobileFixture('ios');
    rewriteMetadata(fixture, {
      ios: { bundle: fixture.relativeBundlePath, assets: [] },
      android: { bundle: '_expo/static/js/android/entry-test.hbc', assets: [] },
    });
    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'ios')).toThrow(
      'exactly the requested platform "ios"',
    );

    rewriteMetadata(fixture, { android: { bundle: fixture.relativeBundlePath, assets: [] } });
    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'ios')).toThrow(
      'exactly the requested platform "ios"',
    );
  });

  it('rejects metadata bundle paths that escape the output directory', () => {
    const fixture = createMobileFixture('ios');
    writeFileSync(join(fixture.mobileDir, 'outside.hbc'), 'outside');
    rewriteMetadata(fixture, { ios: { bundle: '../outside.hbc', assets: [] } });
    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'ios')).toThrow(
      'bundle path escapes the output directory',
    );
  });

  it('rejects metadata whose primary bundle is not executable', () => {
    const fixture = createMobileFixture('ios');
    const otherBundlePath = join(dirname(fixture.bundlePath), 'other.hbc');
    writeFileSync(otherBundlePath, 'other bytecode');
    writeFileSync(
      `${otherBundlePath}.map`,
      JSON.stringify({ version: 3, sources: [], mappings: '', debugId: VALID_DEBUG_ID }),
    );
    const nonBundlePath = join(dirname(fixture.bundlePath), 'not-an-upload-bundle.txt');
    writeFileSync(nonBundlePath, 'not an uploader bundle');
    rewriteMetadata(fixture, { ios: { bundle: '_expo/static/js/ios/not-an-upload-bundle.txt', assets: [] } });
    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'ios')).toThrow(
      'metadata.json platform bundle must end in .js or .hbc',
    );
  });

  it('ignores Expo-copied public JavaScript that metadata does not declare executable', () => {
    const fixture = createMobileFixture('android');
    const publicWorkerPath = join(fixture.outputDir, 'wasm', 'board-render.worker.js');
    const publicGluePath = join(fixture.outputDir, 'wasm', 'board_renderer_wasm.js');
    mkdirSync(dirname(publicWorkerPath), { recursive: true });
    writeFileSync(publicWorkerPath, 'self.onmessage = () => {};');
    writeFileSync(publicGluePath, 'export default function init() {}');

    expect(validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'android')).toHaveLength(1);
  });

  it('validates metadata-declared executable assets when exact bundle/map pairs are present', () => {
    const fixture = createMobileFixture('ios');
    const relativeDomBundlePath = 'www.bundle/1234567890abcdef.js';
    const domBundlePath = join(fixture.outputDir, relativeDomBundlePath);
    mkdirSync(dirname(domBundlePath), { recursive: true });
    writeFileSync(domBundlePath, 'dom component bundle');
    writeFileSync(
      `${domBundlePath}.map`,
      JSON.stringify({ version: 3, sources: [], mappings: '', debugId: VALID_DEBUG_ID }),
    );
    rewriteMetadata(fixture, {
      ios: {
        bundle: fixture.relativeBundlePath,
        assets: [
          { path: 'assets/image-hash', ext: 'png' },
          { path: relativeDomBundlePath, ext: 'js' },
          { path: 'www.bundle/component.html', ext: 'html' },
        ],
      },
    });
    mkdirSync(join(fixture.outputDir, 'assets'), { recursive: true });
    writeFileSync(join(fixture.outputDir, 'assets', 'image-hash'), 'image');
    mkdirSync(join(fixture.outputDir, 'www.bundle'), { recursive: true });
    writeFileSync(join(fixture.outputDir, 'www.bundle', 'component.html'), '<html></html>');

    expect(validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'ios')).toHaveLength(2);
  });

  it('fails closed for Expo 57 DOM metadata whose independently hashed map is not an exact pair', () => {
    const fixture = createMobileFixture('ios');
    const relativeDomBundlePath = 'www.bundle/11111111111111111111111111111111.js';
    const relativeDomMapPath = 'www.bundle/22222222222222222222222222222222.map';
    mkdirSync(join(fixture.outputDir, 'www.bundle'), { recursive: true });
    writeFileSync(join(fixture.outputDir, relativeDomBundlePath), 'dom component bundle');
    writeFileSync(
      join(fixture.outputDir, relativeDomMapPath),
      JSON.stringify({ version: 3, sources: [], mappings: '', debugId: VALID_DEBUG_ID }),
    );
    rewriteMetadata(fixture, {
      ios: {
        bundle: fixture.relativeBundlePath,
        // Expo 57 declares non-map DOM artifacts in metadata. Its map is
        // independently content-hashed and excluded from this assets array.
        assets: [
          { path: relativeDomBundlePath, ext: 'js' },
          { path: 'www.bundle/33333333333333333333333333333333.html', ext: 'html' },
        ],
      },
    });
    writeFileSync(join(fixture.outputDir, 'www.bundle', '33333333333333333333333333333333.html'), '<html></html>');

    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'ios')).toThrow(
      `${relativeDomBundlePath}.map`,
    );
  });

  it('rejects zero, metadata-declared partial, and empty uploader groups', () => {
    const noBundleFixture = createMobileFixture('ios');
    rmSync(noBundleFixture.bundlePath);
    rmSync(noBundleFixture.sourceMapPath);
    expect(() => validateSourceMapOutput(noBundleFixture.mobileDir, noBundleFixture.outputDir, 'ios')).toThrow();

    const partialFixture = createMobileFixture('ios');
    const relativeOrphanPath = 'www.bundle/orphan.js';
    mkdirSync(dirname(join(partialFixture.outputDir, relativeOrphanPath)), { recursive: true });
    writeFileSync(join(partialFixture.outputDir, relativeOrphanPath), 'javascript');
    rewriteMetadata(partialFixture, {
      ios: {
        bundle: partialFixture.relativeBundlePath,
        assets: [{ path: relativeOrphanPath, ext: 'js' }],
      },
    });
    expect(() => validateSourceMapOutput(partialFixture.mobileDir, partialFixture.outputDir, 'ios')).toThrow(
      'Metadata-declared executable asset requires an exact adjacent source map',
    );

    const emptyMapFixture = createMobileFixture('ios');
    const relativeEmptyMapBundlePath = 'www.bundle/empty-map.js';
    const emptyMapBundlePath = join(emptyMapFixture.outputDir, relativeEmptyMapBundlePath);
    mkdirSync(dirname(emptyMapBundlePath), { recursive: true });
    writeFileSync(emptyMapBundlePath, 'dom component bundle');
    writeFileSync(`${emptyMapBundlePath}.map`, '');
    rewriteMetadata(emptyMapFixture, {
      ios: {
        bundle: emptyMapFixture.relativeBundlePath,
        assets: [{ path: relativeEmptyMapBundlePath, ext: 'js' }],
      },
    });
    expect(() => validateSourceMapOutput(emptyMapFixture.mobileDir, emptyMapFixture.outputDir, 'ios')).toThrow(
      'Source map is empty',
    );

    const emptyBundleFixture = createMobileFixture('ios');
    const relativeEmptyBundlePath = 'www.bundle/empty-bundle.js';
    const emptyBundlePath = join(emptyBundleFixture.outputDir, relativeEmptyBundlePath);
    mkdirSync(dirname(emptyBundlePath), { recursive: true });
    writeFileSync(emptyBundlePath, '');
    writeFileSync(
      `${emptyBundlePath}.map`,
      JSON.stringify({ version: 3, sources: [], mappings: '', debugId: VALID_DEBUG_ID }),
    );
    rewriteMetadata(emptyBundleFixture, {
      ios: {
        bundle: emptyBundleFixture.relativeBundlePath,
        assets: [{ path: relativeEmptyBundlePath, ext: 'js' }],
      },
    });
    expect(() => validateSourceMapOutput(emptyBundleFixture.mobileDir, emptyBundleFixture.outputDir, 'ios')).toThrow(
      'Bundle is empty',
    );
  });

  it('rejects invalid maps for metadata-declared executable DOM assets', () => {
    const fixture = createMobileFixture('ios');
    const relativeDomBundlePath = 'www.bundle/invalid.js';
    const domBundlePath = join(fixture.outputDir, relativeDomBundlePath);
    mkdirSync(dirname(domBundlePath), { recursive: true });
    writeFileSync(domBundlePath, 'dom component bundle');
    writeFileSync(`${domBundlePath}.map`, JSON.stringify({ version: 3, debugId: 'invalid' }));
    rewriteMetadata(fixture, {
      ios: {
        bundle: fixture.relativeBundlePath,
        assets: [{ path: relativeDomBundlePath, ext: 'js' }],
      },
    });

    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'ios')).toThrow('no valid Debug ID');
  });

  it('rejects metadata-declared orphan maps, path escapes, symlinks, duplicates, and collisions', () => {
    const orphanMapFixture = createMobileFixture('ios');
    const relativeOrphanMapPath = 'www.bundle/orphan.js.map';
    mkdirSync(join(orphanMapFixture.outputDir, 'www.bundle'), { recursive: true });
    writeFileSync(join(orphanMapFixture.outputDir, relativeOrphanMapPath), '{}');
    rewriteMetadata(orphanMapFixture, {
      ios: {
        bundle: orphanMapFixture.relativeBundlePath,
        assets: [{ path: relativeOrphanMapPath, ext: 'map' }],
      },
    });
    expect(() => validateSourceMapOutput(orphanMapFixture.mobileDir, orphanMapFixture.outputDir, 'ios')).toThrow(
      'source map has no matching executable',
    );

    const escapeFixture = createMobileFixture('ios');
    writeFileSync(join(escapeFixture.mobileDir, 'outside.js'), 'outside');
    rewriteMetadata(escapeFixture, {
      ios: {
        bundle: escapeFixture.relativeBundlePath,
        assets: [{ path: '../outside.js', ext: 'js' }],
      },
    });
    expect(() => validateSourceMapOutput(escapeFixture.mobileDir, escapeFixture.outputDir, 'ios')).toThrow(
      'escapes the output directory',
    );

    const symlinkFixture = createMobileFixture('ios');
    const realAssetPath = join(symlinkFixture.outputDir, 'www.bundle', 'real.js');
    const symlinkAssetPath = join(symlinkFixture.outputDir, 'www.bundle', 'linked.js');
    mkdirSync(dirname(realAssetPath), { recursive: true });
    writeFileSync(realAssetPath, 'real');
    symlinkSync(realAssetPath, symlinkAssetPath);
    rewriteMetadata(symlinkFixture, {
      ios: {
        bundle: symlinkFixture.relativeBundlePath,
        assets: [{ path: 'www.bundle/linked.js', ext: 'js' }],
      },
    });
    expect(() => validateSourceMapOutput(symlinkFixture.mobileDir, symlinkFixture.outputDir, 'ios')).toThrow(
      'contains a symbolic link',
    );

    const duplicateFixture = createMobileFixture('ios');
    rewriteMetadata(duplicateFixture, {
      ios: {
        bundle: duplicateFixture.relativeBundlePath,
        assets: [{ path: duplicateFixture.relativeBundlePath, ext: 'hbc' }],
      },
    });
    expect(() => validateSourceMapOutput(duplicateFixture.mobileDir, duplicateFixture.outputDir, 'ios')).toThrow(
      'duplicate path',
    );

    const collisionFixture = createMobileFixture('ios');
    const lowerCasePath = 'www.bundle/chunk.js';
    const upperCasePath = 'www.bundle/CHUNK.js';
    mkdirSync(join(collisionFixture.outputDir, 'www.bundle'), { recursive: true });
    writeFileSync(join(collisionFixture.outputDir, lowerCasePath), 'lower');
    writeFileSync(join(collisionFixture.outputDir, upperCasePath), 'upper');
    rewriteMetadata(collisionFixture, {
      ios: {
        bundle: collisionFixture.relativeBundlePath,
        assets: [
          { path: lowerCasePath, ext: 'js' },
          { path: upperCasePath, ext: 'js' },
        ],
      },
    });
    expect(() => validateSourceMapOutput(collisionFixture.mobileDir, collisionFixture.outputDir, 'ios')).toThrow(
      'paths collide',
    );
  });

  it('rejects missing, malformed, and inconsistent Debug IDs', () => {
    const fixture = createMobileFixture('android');
    writeFileSync(fixture.sourceMapPath, JSON.stringify({ version: 3, mappings: '' }));
    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'android')).toThrow('no valid Debug ID');

    writeFileSync(fixture.sourceMapPath, JSON.stringify({ version: 3, debugId: 'not-a-debug-id' }));
    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'android')).toThrow('no valid Debug ID');

    writeFileSync(
      fixture.sourceMapPath,
      JSON.stringify({ version: 3, debugId: VALID_DEBUG_ID, debug_id: '87654321-4321-4abc-9def-1234567890ab' }),
    );
    expect(() => validateSourceMapOutput(fixture.mobileDir, fixture.outputDir, 'android')).toThrow(
      'mismatched debugId and debug_id',
    );
  });
});

describe('official Sentry uploader invocation', () => {
  it('pins the installed Sentry React Native uploader to 7.11.0', () => {
    const fixture = createMobileFixture();
    const sentryRoot = join(fixture.mobileDir, 'node_modules', '@sentry', 'react-native');
    const uploaderPath = join(sentryRoot, 'scripts', 'expo-upload-sourcemaps.js');
    mkdirSync(dirname(uploaderPath), { recursive: true });
    writeFileSync(
      join(sentryRoot, 'package.json'),
      JSON.stringify({ name: '@sentry/react-native', version: '7.11.0' }),
    );
    writeFileSync(uploaderPath, '#!/usr/bin/env node\n');
    expect(resolveInstalledSentryUploader(fixture.mobileDir)).toBe(uploaderPath);

    writeFileSync(
      join(sentryRoot, 'package.json'),
      JSON.stringify({ name: '@sentry/react-native', version: '7.12.0' }),
    );
    expect(() => resolveInstalledSentryUploader(fixture.mobileDir)).toThrow(
      'Unsupported @sentry/react-native version 7.12.0',
    );
  });

  it('reports missing mobile directories and installed uploader files clearly', () => {
    const fixture = createMobileFixture();
    const sentryRoot = join(fixture.mobileDir, 'node_modules', '@sentry', 'react-native');
    mkdirSync(sentryRoot, { recursive: true });
    writeFileSync(
      join(sentryRoot, 'package.json'),
      JSON.stringify({ name: '@sentry/react-native', version: '7.11.0' }),
    );

    expect(() => resolveInstalledSentryUploader(join(fixture.mobileDir, 'missing'))).toThrow(
      'Mobile directory does not exist or is not a directory',
    );
    expect(() => resolveInstalledSentryUploader(fixture.mobileDir)).toThrow(
      'Official Sentry Expo source-map uploader is missing',
    );
  });

  it('fixes org/project/url and removes release, dist, and CLI overrides', () => {
    const environment = createSentryUploadEnvironment(
      processEnv({
        SENTRY_AUTH_TOKEN: ' token ',
        SENTRY_ORG: 'wrong',
        SENTRY_PROJECT: 'wrong',
        SENTRY_URL: 'https://wrong.invalid/',
        SENTRY_RELEASE: 'synthetic-release',
        SENTRY_DIST: 'synthetic-dist',
        SENTRY_CLI_EXECUTABLE: '/tmp/untrusted-cli',
      }),
    );
    expect(environment).toMatchObject({
      SENTRY_AUTH_TOKEN: 'token',
      SENTRY_ORG: 'boardsesh',
      SENTRY_PROJECT: 'boardsesh',
      SENTRY_URL: 'https://sentry.io/',
    });
    expect(environment.SENTRY_RELEASE).toBeUndefined();
    expect(environment.SENTRY_DIST).toBeUndefined();
    expect(environment.SENTRY_CLI_EXECUTABLE).toBeUndefined();
  });

  it('requires the auth token before starting the uploader', () => {
    expect(() => createSentryUploadEnvironment(processEnv({}))).toThrow('SENTRY_AUTH_TOKEN is required');
  });

  it('fails validation before resolving or starting the official uploader', () => {
    const fixture = createMobileFixture('ios');
    rmSync(fixture.sourceMapPath);
    let resolverCalled = false;
    let spawnCalled = false;

    expect(() =>
      uploadMobileSourceMaps(
        {
          platform: 'ios',
          mobileDir: fixture.mobileDir,
          outputDir: fixture.outputDir,
          environment: processEnv({ SENTRY_AUTH_TOKEN: 'secret-token' }),
        },
        {
          resolveUploader: () => {
            resolverCalled = true;
            return join(fixture.mobileDir, 'fake-uploader.js');
          },
          spawnUploader: () => {
            spawnCalled = true;
            return { status: 0 };
          },
        },
      ),
    ).toThrow('Primary OTA bundle requires an exact adjacent source map');
    expect(resolverCalled).toBe(false);
    expect(spawnCalled).toBe(false);
  });

  it('surfaces uploader startup errors and cleans its temporary directories', () => {
    const fixture = createMobileFixture('ios');
    let temporaryWorkingDirectory: string | undefined;
    let stagingDirectory: string | undefined;

    expect(() =>
      uploadMobileSourceMaps(
        {
          platform: 'ios',
          mobileDir: fixture.mobileDir,
          outputDir: fixture.outputDir,
          environment: processEnv({ SENTRY_AUTH_TOKEN: 'secret-token' }),
        },
        {
          resolveUploader: () => join(fixture.mobileDir, 'fake-uploader.js'),
          spawnUploader: (_executable, args, options) => {
            temporaryWorkingDirectory = options.cwd;
            stagingDirectory = args[1];
            return { status: null, error: new Error('spawn EACCES') };
          },
        },
      ),
    ).toThrow('Could not start the official Sentry uploader: spawn EACCES');
    expect(existsSync(temporaryWorkingDirectory ?? '')).toBe(false);
    expect(existsSync(stagingDirectory ?? '')).toBe(false);
  });

  it('surfaces nonzero uploader exits and cleans its temporary directories', () => {
    const fixture = createMobileFixture('android');
    let temporaryWorkingDirectory: string | undefined;
    let stagingDirectory: string | undefined;

    expect(() =>
      uploadMobileSourceMaps(
        {
          platform: 'android',
          mobileDir: fixture.mobileDir,
          outputDir: fixture.outputDir,
          environment: processEnv({ SENTRY_AUTH_TOKEN: 'secret-token' }),
        },
        {
          resolveUploader: () => join(fixture.mobileDir, 'fake-uploader.js'),
          spawnUploader: (_executable, args, options) => {
            temporaryWorkingDirectory = options.cwd;
            stagingDirectory = args[1];
            return { status: 17 };
          },
        },
      ),
    ).toThrow('Official Sentry uploader failed with exit code 17');
    expect(existsSync(temporaryWorkingDirectory ?? '')).toBe(false);
    expect(existsSync(stagingDirectory ?? '')).toBe(false);
  });

  it('stages exactly declared executable groups, uses a fresh cwd, and cleans only its temporary root', () => {
    const fixture = createMobileFixture('android');
    const fakeUploaderPath = join(fixture.mobileDir, 'fake-uploader.js');
    const relativeDomBundlePath = 'www.bundle/component.js';
    const domBundlePath = join(fixture.outputDir, relativeDomBundlePath);
    const publicWorkerPath = join(fixture.outputDir, 'wasm', 'board-render.worker.js');
    mkdirSync(dirname(domBundlePath), { recursive: true });
    mkdirSync(dirname(publicWorkerPath), { recursive: true });
    writeFileSync(domBundlePath, 'dom component bundle');
    writeFileSync(
      `${domBundlePath}.map`,
      JSON.stringify({ version: 3, sources: [], mappings: '', debugId: VALID_DEBUG_ID }),
    );
    writeFileSync(publicWorkerPath, 'unmapped public worker');
    rewriteMetadata(fixture, {
      android: {
        bundle: fixture.relativeBundlePath,
        assets: [{ path: relativeDomBundlePath, ext: 'js' }],
      },
    });
    let invocation:
      | {
          executable: string;
          args: string[];
          cwd: string;
          environment: NodeJS.ProcessEnv;
          cwdEntries: string[];
          stagedFiles: string[];
        }
      | undefined;
    let invocationCount = 0;

    const validatedArtifacts = uploadMobileSourceMaps(
      {
        platform: 'android',
        mobileDir: fixture.mobileDir,
        outputDir: fixture.outputDir,
        environment: processEnv({
          SENTRY_AUTH_TOKEN: 'secret-token',
          SENTRY_RELEASE: 'remove-me',
          SENTRY_DIST: 'remove-me-too',
        }),
      },
      {
        resolveUploader: () => fakeUploaderPath,
        spawnUploader: (executable, args, options) => {
          invocationCount += 1;
          invocation = {
            executable,
            args,
            cwd: options.cwd,
            environment: options.env,
            cwdEntries: readdirSync(options.cwd),
            stagedFiles: listRelativeFiles(args[1]).sort(),
          };
          writeFileSync(join(args[1], `${fixture.relativeBundlePath}.map`), 'mutated staged map');
          return { status: 0 };
        },
      },
    );

    // The official uploader accepts one staging directory. One invocation must
    // therefore contain every pair validation accepted, rather than silently
    // dropping a pair or launching a partially independent upload.
    expect(invocationCount).toBe(1);
    expect(validatedArtifacts).toHaveLength(2);
    expect(invocation).toBeDefined();
    expect(invocation?.executable).toBe('node');
    expect(invocation?.args[0]).toBe(fakeUploaderPath);
    expect(invocation?.args[1]).not.toBe(fixture.outputDir);
    expect(invocation?.cwdEntries).toEqual([]);
    expect(invocation?.stagedFiles).toEqual(
      [
        fixture.relativeBundlePath,
        `${fixture.relativeBundlePath}.map`,
        relativeDomBundlePath,
        `${relativeDomBundlePath}.map`,
      ].sort(),
    );
    expect(invocation?.environment.SENTRY_AUTH_TOKEN).toBe('secret-token');
    expect(invocation?.environment.SENTRY_RELEASE).toBeUndefined();
    expect(invocation?.environment.SENTRY_DIST).toBeUndefined();
    expect(invocation?.cwd).toContain('boardsesh-sentry-upload-');
    expect(existsSync(invocation?.cwd ?? '')).toBe(false);
    expect(existsSync(invocation?.args[1] ?? '')).toBe(false);
    expect(existsSync(fixture.outputDir)).toBe(true);
    expect(existsSync(publicWorkerPath)).toBe(true);
    expect(readFileSync(fixture.sourceMapPath, 'utf8')).toContain(VALID_DEBUG_ID);
  });
});

describe('source-map CLI arguments', () => {
  it('requires one native platform', () => {
    expect(parseUploadArgs(['--platform', 'ios'])).toBe('ios');
    expect(parseUploadArgs(['-p', 'ios'])).toBe('ios');
    expect(parseUploadArgs(['--platform=android'])).toBe('android');
    expect(() => parseUploadArgs([])).toThrow('--platform is required');
    expect(() => parseUploadArgs(['--platform', 'all'])).toThrow('--platform is required');
    expect(() => parseUploadArgs(['--other'])).toThrow('Unknown argument');
  });
});

describe('self-hosted OTA publisher and workflow contracts', () => {
  it('retains production EOAS source maps without adding export work to either preview path', () => {
    const productionArgs = buildSelfHostedEoasArgs('production', 'ios', 'source-map contract');
    const selfHostedPreviewArgs = buildSelfHostedEoasArgs('pr-4134', 'ios', 'preview contract');
    const easArgs = buildEasUpdateArgs('preview', 'preview contract', 'ios');

    expect(productionArgs.filter((argument) => argument === '--dumpSourcemap')).toEqual(['--dumpSourcemap']);
    expect(
      productionArgs.slice(productionArgs.indexOf('--outputDir'), productionArgs.indexOf('--outputDir') + 2),
    ).toEqual(['--outputDir', 'dist']);
    expect(selfHostedPreviewArgs).not.toContain('--dumpSourcemap');
    expect(selfHostedPreviewArgs).not.toContain('--outputDir');
    expect(easArgs).not.toContain('--dumpSourcemap');
    expect(easArgs).not.toContain('--outputDir');
  });

  it('publishes and uploads each production platform before the next export cleans dist', () => {
    const workflow = readRepositoryFile('.github/workflows/mobile-ota-production.yml');
    const orderedSteps = [
      'Publish iOS OTA',
      'Upload iOS OTA source maps to Sentry',
      'Publish Android OTA',
      'Upload Android OTA source maps to Sentry',
      'Push changelog to main',
      'Notify deployments channel',
      'OTA health check (non-blocking)',
      'Notify OTA health to Discord',
      'Warn that published OTA source maps are missing',
      'Require every published OTA source-map upload',
      'Notify deployments channel of failure',
    ];
    const positions = orderedSteps.map((stepName) => workflow.indexOf(`- name: ${stepName}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));

    for (const stepName of ['Upload iOS OTA source maps to Sentry', 'Upload Android OTA source maps to Sentry']) {
      const step = workflowStep(workflow, stepName);
      expect(step).toContain('continue-on-error: true');
      expect(step).toContain('timeout-minutes: 10');
      expect(step).toMatch(/^\s+SENTRY_AUTH_TOKEN:\s*\$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}$/m);
      expect(step).toContain('vp run mobile:upload-sourcemaps');
    }
    expect((workflow.match(/^\s+SENTRY_AUTH_TOKEN:/gm) ?? []).length).toBe(2);
    for (const gateStepName of [
      'Warn that published OTA source maps are missing',
      'Require every published OTA source-map upload',
    ]) {
      const sourceMapGate = workflowStep(workflow, gateStepName);
      for (const platform of ['ios', 'android']) {
        expect(sourceMapGate).toContain(`steps.publish_${platform}.outcome == 'success'`);
        expect(sourceMapGate).toContain(`steps.upload_sourcemaps_${platform}.outcome != 'success'`);
      }
    }
    const failureNotification = workflowStep(workflow, 'Notify deployments channel of failure');
    expect(failureNotification).toContain('Production OTA workflow failed');
    expect(failureNotification).not.toContain('Production OTA publish failed');
    expect(failureNotification).toContain('IOS_MAP_OUTCOME: ${{ steps.upload_sourcemaps_ios.outcome }}');
    expect(failureNotification).toContain('ANDROID_MAP_OUTCOME: ${{ steps.upload_sourcemaps_android.outcome }}');
    expect(failureNotification).toContain('iOS publish: %s · source maps: %s');
    expect(failureNotification).toContain('Android publish: %s · source maps: %s');
    expect(workflowStep(workflow, 'Warn that published OTA source maps are missing')).not.toContain(
      'DISCORD_DEPLOY_WEBHOOK',
    );
  });

  it('overlays trusted tooling before authoritative backport verification and never uploads on dry-run', () => {
    const workflow = readRepositoryFile('.github/workflows/mobile-ota-backport.yml');
    const orderedSteps = [
      'Snapshot trusted OTA publish tooling',
      'Locate the release anchor and prepare the hotfix tree',
      'Overlay trusted OTA publish tooling',
      'Validate anchored Sentry uploader support',
      'Resolve fingerprint and verify it matches the approved anchor',
      'Publish OTA to the approved release',
      'Upload backport OTA source maps to Sentry',
      'Warn that the published backport source maps are missing',
      'Require the published backport source-map upload',
    ];
    const positions = orderedSteps.map((stepName) => workflow.indexOf(`- name: ${stepName}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));

    const snapshotStep = workflowStep(workflow, 'Snapshot trusted OTA publish tooling');
    expect(snapshotStep).toContain('git show "$GITHUB_SHA:$source_path"');
    expect(snapshotStep).toContain('scripts/mobile-publish.ts');
    expect(snapshotStep).toContain('scripts/lib/eoas.ts');
    expect(snapshotStep).toContain('scripts/lib/mobile-publish-retry.ts');
    expect(snapshotStep).toContain('scripts/mobile-upload-sourcemaps.ts');
    const trustedPublisher = readRepositoryFile('scripts/mobile-publish.ts');
    expect(trustedPublisher).toContain("'vp exec'");
    expect(trustedPublisher).toContain("spawnSync('vp', ['exec', 'expo', '--version']");
    expect(trustedPublisher).not.toContain("'pnpm exec'");
    expect(trustedPublisher).not.toContain("spawnSync('pnpm'");
    const overlayStep = workflowStep(workflow, 'Overlay trusted OTA publish tooling');
    expect(overlayStep).toContain(
      'cp "$tooling_root/scripts/lib/mobile-publish-retry.ts" scripts/lib/mobile-publish-retry.ts',
    );
    expect(overlayStep).toContain(
      'git add scripts/mobile-publish.ts scripts/lib/eoas.ts scripts/lib/mobile-publish-retry.ts',
    );
    const overlayCommitGuardPosition = overlayStep.indexOf('if ! git diff --cached --quiet; then');
    const overlayNamePosition = overlayStep.indexOf('git config user.name "github-actions[bot]"');
    const overlayEmailPosition = overlayStep.indexOf(
      'git config user.email "github-actions[bot]@users.noreply.github.com"',
    );
    const overlayCommitPosition = overlayStep.indexOf('git commit -m "chore(ota): overlay trusted publish tooling"');
    expect(overlayCommitGuardPosition).toBeGreaterThanOrEqual(0);
    expect(overlayNamePosition).toBeGreaterThan(overlayCommitGuardPosition);
    expect(overlayEmailPosition).toBeGreaterThan(overlayCommitGuardPosition);
    expect(overlayNamePosition).toBeLessThan(overlayCommitPosition);
    expect(overlayEmailPosition).toBeLessThan(overlayCommitPosition);
    expect(overlayStep).toContain('git status --porcelain');
    expect(workflowStep(workflow, 'Snapshot trusted OTA publish tooling')).toContain(
      "Could not snapshot trusted OTA tooling file '$source_path'",
    );
    expect(workflowStep(workflow, 'Validate anchored Sentry uploader support')).toContain('7.11.0');

    const uploadStep = workflowStep(workflow, 'Upload backport OTA source maps to Sentry');
    expect(uploadStep).toContain("!inputs.dry_run && steps.publish.outcome == 'success'");
    expect(uploadStep).toContain('continue-on-error: true');
    expect(uploadStep).toContain('timeout-minutes: 10');
    expect(uploadStep).toContain('run: node --import tsx scripts/mobile-upload-sourcemaps.ts');
    expect((workflow.match(/^\s+SENTRY_AUTH_TOKEN:/gm) ?? []).length).toBe(1);
    const backportGate = workflowStep(workflow, 'Require the published backport source-map upload');
    expect(backportGate).toContain('!inputs.dry_run');
    expect(backportGate).toContain("steps.publish.outcome == 'success'");
    expect(backportGate).toContain("steps.upload_sourcemaps.outcome != 'success'");
    expect(workflowStep(workflow, 'Validate anchored Sentry uploader support')).toContain(
      '.devDependencies["@sentry/react-native"]',
    );
  });

  it('never uploads source maps or exposes a Sentry token in PR previews', () => {
    const previewWorkflow = readRepositoryFile('.github/workflows/mobile-ota-preview.yml');
    expect(previewWorkflow).toContain('vp run mobile:publish');
    expect(previewWorkflow).not.toContain('mobile:upload-sourcemaps');
    expect(previewWorkflow).not.toContain('mobile-upload-sourcemaps.ts');
    expect(previewWorkflow).not.toMatch(/^\s+SENTRY_AUTH_TOKEN:/gm);
  });
});
