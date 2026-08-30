/// <reference types="node" />

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectArchiveDsyms,
  parseUploadDsymsArgs,
  parseUploadSummary,
  resolveSentryCli,
  uploadArchiveDsyms,
} from './mobile-upload-dsyms';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const createdDirectories: string[] = [];

/** The real output from run 30781376709 — the #4202 symptom, executables only. */
const EXECUTABLES_ONLY_OUTPUT = [
  '> Found 31 debug information files',
  '> Prepared debug information files for upload',
  '> Uploaded 3 missing debug information files',
  '> File upload complete:',
  '',
  '  UPLOADED d69bd35e-63ce-3442-8292-e49dc3f59ace (Boardsesh.app/Boardsesh; arm64 executable)',
  '  UPLOADED 9eef0f2c-e2a3-3b64-ba15-7b31c56bcb50 (BoardseshBeta.appex/BoardseshBeta; arm64 executable)',
  '  UPLOADED e165a021-6f84-3980-a05f-c0c3b66c5a6c (BoardseshWidgets.appex/BoardseshWidgets; arm64 executable)',
].join('\n');

/** What the fixed step must produce instead. */
const DEBUG_COMPANIONS_OUTPUT = [
  '> Found 4 debug information files',
  '> Uploaded 2 missing debug information files',
  '> File upload complete:',
  '',
  '  UPLOADED d69bd35e-63ce-3442-8292-e49dc3f59ace (Boardsesh.app.dSYM; arm64 debug companion)',
  '  UPLOADED 9eef0f2c-e2a3-3b64-ba15-7b31c56bcb50 (BoardseshBeta.appex.dSYM; arm64 debug companion)',
].join('\n');

interface ArchiveFixture {
  archivePath: string;
  dsymsDir: string;
  mobileDir: string;
}

function createArchiveFixture(bundleNames: readonly string[] = ['Boardsesh.app.dSYM']): ArchiveFixture {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'boardsesh-dsyms-test-')));
  createdDirectories.push(fixtureRoot);
  const archivePath = join(fixtureRoot, 'Boardsesh.xcarchive');
  const dsymsDir = join(archivePath, 'dSYMs');
  mkdirSync(dsymsDir, { recursive: true });
  for (const bundleName of bundleNames) addDsymBundle(dsymsDir, bundleName);
  const mobileDir = join(fixtureRoot, 'mobile');
  mkdirSync(mobileDir);
  writeFileSync(join(mobileDir, 'package.json'), '{"name":"fixture"}\n');
  return { archivePath, dsymsDir, mobileDir };
}

function addDsymBundle(dsymsDir: string, bundleName: string, dwarfContents = 'DWARF'): string {
  const dwarfDir = join(dsymsDir, bundleName, 'Contents', 'Resources', 'DWARF');
  mkdirSync(dwarfDir, { recursive: true });
  writeFileSync(join(dwarfDir, bundleName.replace(/\.(app|appex|framework)?\.dSYM$/, '')), dwarfContents);
  return join(dsymsDir, bundleName);
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directoryPath = createdDirectories.pop();
    if (directoryPath) rmSync(directoryPath, { recursive: true, force: true });
  }
});

describe('archive dSYM validation', () => {
  it('collects every dSYM bundle that carries a DWARF payload', () => {
    const fixture = createArchiveFixture(['Boardsesh.app.dSYM', 'BoardseshWidgets.appex.dSYM']);
    expect(collectArchiveDsyms(fixture.archivePath)).toEqual({
      dsymsDir: fixture.dsymsDir,
      bundleNames: ['Boardsesh.app.dSYM', 'BoardseshWidgets.appex.dSYM'],
      appBundleNames: ['Boardsesh.app.dSYM'],
    });
  });

  it('rejects a missing archive or a missing dSYMs directory', () => {
    const fixture = createArchiveFixture();
    expect(() => collectArchiveDsyms(join(fixture.archivePath, 'nope.xcarchive'))).toThrow('Xcode archive does not');
    rmSync(fixture.dsymsDir, { recursive: true, force: true });
    expect(() => collectArchiveDsyms(fixture.archivePath)).toThrow("Archive's dSYMs directory does not exist");
  });

  it('rejects a symlinked dSYMs directory', () => {
    const fixture = createArchiveFixture();
    const decoyArchive = join(dirname(fixture.archivePath), 'Decoy.xcarchive');
    mkdirSync(decoyArchive);
    symlinkSync(fixture.dsymsDir, join(decoyArchive, 'dSYMs'));
    expect(() => collectArchiveDsyms(decoyArchive)).toThrow('Refusing symbolic-link');
  });

  it('rejects bundles with no DWARF payload', () => {
    const fixture = createArchiveFixture([]);
    mkdirSync(join(fixture.dsymsDir, 'Boardsesh.app.dSYM', 'Contents', 'Resources', 'DWARF'), { recursive: true });
    expect(() => collectArchiveDsyms(fixture.archivePath)).toThrow('No dSYM bundles with a DWARF payload');
  });

  // A link can't stand in for the debug information we're asserting on.
  it('does not count a symlinked DWARF entry as a payload', () => {
    const fixture = createArchiveFixture([]);
    const dwarfDir = join(fixture.dsymsDir, 'Boardsesh.app.dSYM', 'Contents', 'Resources', 'DWARF');
    mkdirSync(dwarfDir, { recursive: true });
    const realPayload = join(dirname(fixture.archivePath), 'elsewhere-dwarf');
    writeFileSync(realPayload, 'DWARF');
    symlinkSync(realPayload, join(dwarfDir, 'Boardsesh'));
    expect(() => collectArchiveDsyms(fixture.archivePath)).toThrow('No dSYM bundles with a DWARF payload');
  });

  // The #4202 regression itself: the appexes' dSYMs existed early enough to be
  // uploaded, the app's did not — and only the app's carries the DWARF for
  // statically linked pods like libRNScreens.a.
  it('rejects an archive whose only dSYMs are extensions', () => {
    const fixture = createArchiveFixture(['BoardseshBeta.appex.dSYM', 'BoardseshWidgets.appex.dSYM']);
    expect(() => collectArchiveDsyms(fixture.archivePath)).toThrow('No *.app.dSYM');
  });
});

describe('sentry-cli upload output', () => {
  it('reads the counts and tells executables apart from debug companions', () => {
    expect(parseUploadSummary(EXECUTABLES_ONLY_OUTPUT)).toEqual({ found: 31, uploaded: 3, debugCompanions: 0 });
    expect(parseUploadSummary(DEBUG_COMPANIONS_OUTPUT)).toEqual({ found: 4, uploaded: 2, debugCompanions: 2 });
  });

  it('reports zero for output with no counts at all', () => {
    expect(parseUploadSummary('')).toEqual({ found: 0, uploaded: 0, debugCompanions: 0 });
  });
});

// The repo's Next global.d.ts augments NodeJS.ProcessEnv to require NODE_ENV, so
// the partial env fixtures below need the assertion to be assignable.
function processEnv(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe('uploadArchiveDsyms', () => {
  const environment = processEnv({ SENTRY_AUTH_TOKEN: 'test-token' });
  const emptyEnvironment = processEnv({});

  it('invokes sentry-cli against the archive dSYMs with the boardsesh Sentry env', () => {
    const fixture = createArchiveFixture(['Boardsesh.app.dSYM', 'BoardseshBeta.appex.dSYM']);
    const invocations: { executable: string; args: string[]; options: Record<string, unknown> }[] = [];

    const result = uploadArchiveDsyms(
      { archivePath: fixture.archivePath, mobileDir: fixture.mobileDir, environment },
      {
        resolveSentryCli: () => '/fake/sentry-cli',
        spawnSentryCli: (executable, args, options) => {
          invocations.push({ executable, args, options });
          return { status: 0, stdout: DEBUG_COMPANIONS_OUTPUT };
        },
      },
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0].executable).toBe('/fake/sentry-cli');
    expect(invocations[0].args).toEqual(['debug-files', 'upload', fixture.dsymsDir]);
    expect(invocations[0].options.env).toMatchObject({
      SENTRY_AUTH_TOKEN: 'test-token',
      SENTRY_ORG: 'boardsesh',
      SENTRY_PROJECT: 'boardsesh',
    });
    // Bounded: this step gates the TestFlight export, so it must not hang, and
    // Node's 1 MB default maxBuffer must not kill a healthy upload.
    expect(invocations[0].options.timeout).toBe(600_000);
    expect(invocations[0].options.maxBuffer).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    expect(result).toMatchObject({ found: 4, uploaded: 2, debugCompanions: 2 });
  });

  // Uploading something that isn't a debug companion is the #4202 signature.
  // Warned, not thrown: this step gates the TestFlight upload and the check
  // depends on sentry-cli's output wording, which must not block a release.
  it('warns when it uploaded files but none were debug companions', () => {
    const fixture = createArchiveFixture();
    const warnings: string[] = [];
    const restoreWarn = vi.spyOn(console, 'warn').mockImplementation((message: string) => void warnings.push(message));
    try {
      const result = uploadArchiveDsyms(
        { archivePath: fixture.archivePath, mobileDir: fixture.mobileDir, environment },
        {
          resolveSentryCli: () => '/fake/sentry-cli',
          spawnSentryCli: () => ({ status: 0, stdout: EXECUTABLES_ONLY_OUTPUT }),
        },
      );
      expect(result).toMatchObject({ uploaded: 3, debugCompanions: 0 });
    } finally {
      restoreWarn.mockRestore();
    }
    expect(warnings.join('\n')).toContain('only 0 were reported as a debug companion');
  });

  // A partial count is as much of a red flag as none at all.
  it('warns when only some of the uploaded files were debug companions', () => {
    const fixture = createArchiveFixture();
    const warnings: string[] = [];
    const restoreWarn = vi.spyOn(console, 'warn').mockImplementation((message: string) => void warnings.push(message));
    try {
      uploadArchiveDsyms(
        { archivePath: fixture.archivePath, mobileDir: fixture.mobileDir, environment },
        {
          resolveSentryCli: () => '/fake/sentry-cli',
          spawnSentryCli: () => ({
            status: 0,
            stdout: [
              '> Found 4 debug information files',
              '> Uploaded 2 missing debug information files',
              '  UPLOADED d69bd35e-63ce-3442-8292-e49dc3f59ace (Boardsesh.app.dSYM; arm64 debug companion)',
              '  UPLOADED 9eef0f2c-e2a3-3b64-ba15-7b31c56bcb50 (BoardseshBeta.appex/BoardseshBeta; arm64 executable)',
            ].join('\n'),
          }),
        },
      );
    } finally {
      restoreWarn.mockRestore();
    }
    expect(warnings.join('\n')).toContain('only 1 were reported as a debug companion');
  });

  // A re-run against an archive Sentry already has uploads nothing and lists no
  // companions — that's expected, and must not trip the warning above.
  it('accepts a run where Sentry already had every dSYM, without warning', () => {
    const fixture = createArchiveFixture();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = uploadArchiveDsyms(
        { archivePath: fixture.archivePath, mobileDir: fixture.mobileDir, environment },
        {
          resolveSentryCli: () => '/fake/sentry-cli',
          spawnSentryCli: () => ({
            status: 0,
            stdout: '> Found 4 debug information files\n> Uploaded 0 missing debug information files\n',
          }),
        },
      );
      expect(result).toMatchObject({ found: 4, uploaded: 0, debugCompanions: 0 });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fails on a non-zero exit, an unstartable CLI, or an empty local scan', () => {
    const fixture = createArchiveFixture();
    const dependencies = { resolveSentryCli: () => '/fake/sentry-cli' };
    const options = { archivePath: fixture.archivePath, mobileDir: fixture.mobileDir, environment };

    expect(() =>
      uploadArchiveDsyms(options, {
        ...dependencies,
        spawnSentryCli: () => ({ status: 1, stderr: 'error: API request failed' }),
      }),
    ).toThrow('exit code 1');

    expect(() =>
      uploadArchiveDsyms(options, {
        ...dependencies,
        spawnSentryCli: () => ({ status: null, error: new Error('ENOENT') }),
      }),
    ).toThrow('Could not run sentry-cli');

    // A hung upload would otherwise hold the TestFlight export until the job's
    // own timeout, so the kill must be reported as what it is.
    const timeoutError: NodeJS.ErrnoException = new Error('spawnSync ETIMEDOUT');
    timeoutError.code = 'ETIMEDOUT';
    expect(() =>
      uploadArchiveDsyms(options, {
        ...dependencies,
        spawnSentryCli: () => ({ status: null, error: timeoutError }),
      }),
    ).toThrow('did not finish within 10 minutes');

    expect(() =>
      uploadArchiveDsyms(options, {
        ...dependencies,
        spawnSentryCli: () => ({ status: 0, stdout: '> Found 0 debug information files\n' }),
      }),
    ).toThrow('found no debug information files');
  });

  // Validating the archive before the token means a local run without
  // SENTRY_AUTH_TOKEN still reports the real problem.
  it('validates the archive before requiring an auth token', () => {
    const fixture = createArchiveFixture(['BoardseshWidgets.appex.dSYM']);
    expect(() =>
      uploadArchiveDsyms({
        archivePath: fixture.archivePath,
        mobileDir: fixture.mobileDir,
        environment: emptyEnvironment,
      }),
    ).toThrow('No *.app.dSYM');
  });

  it('requires an auth token once the archive checks out', () => {
    const fixture = createArchiveFixture();
    expect(() =>
      uploadArchiveDsyms({
        archivePath: fixture.archivePath,
        mobileDir: fixture.mobileDir,
        environment: emptyEnvironment,
      }),
    ).toThrow('SENTRY_AUTH_TOKEN is required');
  });
});

describe('sentry-cli resolution', () => {
  it('resolves the installed binary from packages/mobile', () => {
    const executablePath = resolveSentryCli(resolve(REPO_ROOT, 'packages/mobile'));
    expect(executablePath).toContain('sentry-cli');
  });

  it('explains the direct-dependency requirement when it cannot resolve', () => {
    const fixture = createArchiveFixture();
    expect(() => resolveSentryCli(fixture.mobileDir)).toThrow('direct dependency');
  });
});

describe('argument parsing', () => {
  it('accepts both --archive forms and defaults to the workflow archive path', () => {
    expect(parseUploadDsymsArgs(['--archive', '/tmp/A.xcarchive'])).toEqual({ archivePath: '/tmp/A.xcarchive' });
    expect(parseUploadDsymsArgs(['--', '--archive=/tmp/B.xcarchive'])).toEqual({ archivePath: '/tmp/B.xcarchive' });
    expect(parseUploadDsymsArgs([]).archivePath).toBe(
      resolve(REPO_ROOT, 'packages/mobile/ios/build/Boardsesh.xcarchive'),
    );
  });

  it('rejects unknown, empty, and value-less arguments', () => {
    expect(() => parseUploadDsymsArgs(['--platform', 'ios'])).toThrow('Unknown argument');
    expect(() => parseUploadDsymsArgs(['--archive', ''])).toThrow('--archive requires a path');
    // Must not silently fall back to the default archive.
    expect(() => parseUploadDsymsArgs(['--archive'])).toThrow('--archive requires a path');
  });
});

describe('iOS TestFlight workflow wiring', () => {
  const workflow = readRepositoryFile('.github/workflows/ios-testflight-rn.yml');

  it('uploads the dSYMs from the finished archive, not from the build phase', () => {
    expect(workflow).toContain('run: vp run mobile:upload-dsyms -- --archive "$ARCHIVE_PATH"');
    // vp is not otherwise set up in this macOS job.
    expect(workflow).toContain('voidzero-dev/setup-vp@v1');
  });

  // The step hard-fails, so it has to run while a failure is still recoverable:
  // after the TestFlight export the binary has shipped, and after the
  // fingerprint tag the next push skips the native build entirely — either way
  // the dSYMs would never get a second chance without a manual rebuild.
  it('runs the upload before the TestFlight export and the fingerprint tag', () => {
    const uploadIndex = workflow.indexOf('- name: Upload iOS dSYMs to Sentry');
    expect(uploadIndex).toBeGreaterThan(workflow.indexOf('- name: Archive'));
    expect(uploadIndex).toBeLessThan(workflow.indexOf('- name: Export archive (uploads to TestFlight)'));
    expect(uploadIndex).toBeLessThan(workflow.indexOf('- name: Tag the uploaded iOS build and fingerprint'));
  });

  it('registers the vp task the workflow calls', () => {
    expect(readRepositoryFile('vite.config.ts')).toContain("'mobile:upload-dsyms'");
  });
});
