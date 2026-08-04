/// <reference types="node" />

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'boardsesh-dsyms-test-'));
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

describe('uploadArchiveDsyms', () => {
  const environment = { SENTRY_AUTH_TOKEN: 'test-token' };

  it('invokes sentry-cli against the archive dSYMs with the boardsesh Sentry env', () => {
    const fixture = createArchiveFixture(['Boardsesh.app.dSYM', 'BoardseshBeta.appex.dSYM']);
    const invocations: { executable: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];

    const result = uploadArchiveDsyms(
      { archivePath: fixture.archivePath, mobileDir: fixture.mobileDir, environment },
      {
        resolveSentryCli: () => '/fake/sentry-cli',
        spawnSentryCli: (executable, args, options) => {
          invocations.push({ executable, args, env: options.env });
          return { status: 0, stdout: DEBUG_COMPANIONS_OUTPUT };
        },
      },
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0].executable).toBe('/fake/sentry-cli');
    expect(invocations[0].args).toEqual(['debug-files', 'upload', fixture.dsymsDir]);
    expect(invocations[0].env).toMatchObject({
      SENTRY_AUTH_TOKEN: 'test-token',
      SENTRY_ORG: 'boardsesh',
      SENTRY_PROJECT: 'boardsesh',
    });
    expect(result).toMatchObject({ found: 4, uploaded: 2, debugCompanions: 2 });
  });

  it('accepts a run where Sentry already had every dSYM', () => {
    const fixture = createArchiveFixture();
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
    ).toThrow('Could not start sentry-cli');

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
      uploadArchiveDsyms({ archivePath: fixture.archivePath, mobileDir: fixture.mobileDir, environment: {} }),
    ).toThrow('No *.app.dSYM');
  });

  it('requires an auth token once the archive checks out', () => {
    const fixture = createArchiveFixture();
    expect(() =>
      uploadArchiveDsyms({ archivePath: fixture.archivePath, mobileDir: fixture.mobileDir, environment: {} }),
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

  it('rejects unknown and empty arguments', () => {
    expect(() => parseUploadDsymsArgs(['--platform', 'ios'])).toThrow('Unknown argument');
    expect(() => parseUploadDsymsArgs(['--archive', ''])).toThrow('--archive requires a path');
  });
});

describe('iOS TestFlight workflow wiring', () => {
  const workflow = readRepositoryFile('.github/workflows/ios-testflight-rn.yml');

  it('uploads the dSYMs from the finished archive, not from the build phase', () => {
    expect(workflow).toContain('run: vp run mobile:upload-dsyms -- --archive "$ARCHIVE_PATH"');
    // vp is not otherwise set up in this macOS job.
    expect(workflow).toContain('voidzero-dev/setup-vp@v1');
  });

  // A failure here must not skip the tag steps: without the fingerprint tag the
  // next push to main rebuilds and re-uploads the same binary to TestFlight.
  it('runs the upload after the fingerprint and build-number tags', () => {
    expect(workflow.indexOf('- name: Upload iOS dSYMs to Sentry')).toBeGreaterThan(
      workflow.indexOf('- name: Tag the uploaded iOS build number'),
    );
  });

  it('registers the vp task the workflow calls', () => {
    expect(readRepositoryFile('vite.config.ts')).toContain("'mobile:upload-dsyms'");
  });
});
