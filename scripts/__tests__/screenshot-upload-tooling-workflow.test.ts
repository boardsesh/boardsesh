/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

const workflow = parse(readFileSync('.github/workflows/mobile-screenshots-ios.yml', 'utf8')) as {
  jobs: Record<string, { steps: WorkflowStep[] }>;
};
const steps = workflow.jobs['ios-finalize'].steps;
const checkout = steps.find((step) => step.name === 'Checkout trusted screenshot upload tooling');
const install = steps.find((step) => step.name === 'Install trusted screenshot upload tooling');

function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(directory: string, path: string, contents: string): void {
  const target = join(directory, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commit(directory: string): string {
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'Test');
  git(directory, 'config', 'user.email', 'test@example.invalid');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'fixture');
  return git(directory, 'rev-parse', 'HEAD');
}

describe('trusted iOS screenshot uploader', () => {
  it('pins a sparse uploader checkout after capture validation and before Ruby or Apple credentials', () => {
    expect(checkout?.uses).toBe('actions/checkout@v4');
    expect(checkout?.with).toEqual({
      ref: '${{ github.workflow_sha }}',
      path: '.boardsesh/store-upload-tooling',
      'sparse-checkout': 'fastlane',
      'persist-credentials': false,
    });
    const upload = steps.find((step) => step.name === 'Upload screenshots to App Store Connect');
    expect(checkout?.if).toBe(upload?.if);
    expect(install?.if).toBe(upload?.if);
    expect(install?.env).toEqual({
      APP_SOURCE_SHA: '${{ needs.setup.outputs.source_sha }}',
      STORE_UPLOAD_TOOLING_SHA: '${{ github.workflow_sha }}',
    });
    const installIndex = steps.indexOf(install!);
    for (const name of [
      'Assert screenshot dimensions',
      'Assert screenshot content',
      'Validate and stage selected-language upload',
    ]) {
      expect(steps.findIndex((step) => step.name === name)).toBeLessThan(steps.indexOf(checkout!));
    }
    for (const name of [
      'Set up Ruby + fastlane',
      'Install fastlane gems',
      'Decode App Store Connect API key',
      'Upload screenshots to App Store Connect',
    ]) {
      expect(steps.findIndex((step) => step.name === name)).toBeGreaterThan(installIndex);
    }
    expect(install?.run).not.toMatch(/origin\/main|git (?:checkout|fetch|reset)/);
  });

  it.each(['valid', 'wrong application', 'wrong uploader'] as const)(
    'replaces only unsafe uploader files and requires exact source identities: %s',
    (identity) => {
      const directory = mkdtempSync(join(tmpdir(), 'screenshot-upload-tooling-'));
      try {
        const unsafeFastfile = 'upload_to_app_store(sync_screenshots: true)\n';
        write(directory, 'fastlane/Fastfile', unsafeFastfile);
        write(directory, 'fastlane/Gemfile', 'old gems\n');
        write(directory, 'fastlane/Gemfile.lock', 'old lock\n');
        write(directory, 'fastlane/lib/unsafe.rb', 'old global sync\n');
        const protectedFiles = {
          'packages/mobile/app.config.ts': "export default { version: '2.8.0' };\n",
          'app-stores/apple/screenshots/zh-Hans/iphone-duo/01.png': 'captured PNG bytes\n',
          'app-stores/presentation/zh-CN.json': '{"caption":"原始中文"}\n',
          'fastlane/metadata/en-US/description.txt': 'captured listing text\n',
          'fastlane/Appfile': 'captured app identifier\n',
        };
        for (const [path, contents] of Object.entries(protectedFiles)) write(directory, path, contents);
        const appSha = commit(directory);
        // main advances, but this captured worktree remains on its receipt SHA.
        git(directory, 'commit', '--allow-empty', '-m', 'new main');
        git(directory, 'checkout', '--detach', appSha);

        const tooling = join(directory, '.boardsesh/store-upload-tooling');
        for (const filename of ['Fastfile', 'Gemfile', 'Gemfile.lock']) {
          write(tooling, `fastlane/${filename}`, readFileSync(`fastlane/${filename}`, 'utf8'));
        }
        cpSync('fastlane/lib', join(tooling, 'fastlane/lib'), { recursive: true });
        const toolingSha = commit(tooling);
        git(tooling, 'commit', '--allow-empty', '-m', 'new workflow main');
        git(tooling, 'checkout', '--detach', toolingSha);

        const result = spawnSync('bash', ['--noprofile', '--norc', '-c', install!.run!], {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            BASH_ENV: undefined,
            APP_SOURCE_SHA: identity === 'wrong application' ? 'a'.repeat(40) : appSha,
            STORE_UPLOAD_TOOLING_SHA: identity === 'wrong uploader' ? 'b'.repeat(40) : toolingSha,
          },
        });
        for (const [path, contents] of Object.entries(protectedFiles)) {
          expect(readFileSync(join(directory, path), 'utf8'), path).toBe(contents);
        }
        expect(git(directory, 'rev-parse', 'HEAD')).toBe(appSha);
        if (identity !== 'valid') {
          expect(result.status).not.toBe(0);
          expect(result.stdout).toContain('does not match its immutable source');
          expect(readFileSync(join(directory, 'fastlane/Fastfile'), 'utf8')).toBe(unsafeFastfile);
          expect(existsSync(join(directory, 'fastlane/lib/unsafe.rb'))).toBe(true);
          return;
        }
        expect(result.status, result.stderr).toBe(0);
        for (const filename of ['Fastfile', 'Gemfile', 'Gemfile.lock', 'lib/screenshot_upload.rb']) {
          expect(readFileSync(join(directory, 'fastlane', filename), 'utf8')).toBe(
            readFileSync(`fastlane/${filename}`, 'utf8'),
          );
        }
        expect(readFileSync(join(directory, 'fastlane/Fastfile'), 'utf8')).toContain('BoardseshScreenshotUpload.sync');
        expect(existsSync(join(directory, 'fastlane/lib/unsafe.rb'))).toBe(false);
        expect(result.stdout).toContain(`Screenshot upload tooling: ${toolingSha}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
