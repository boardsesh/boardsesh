import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function fixtureXcode(path: string, version: string): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'fixture-version'), version);
  return path;
}
function runSelector(directory: string) {
  const appDirectory = join(directory, 'Applications');
  const environmentFile = join(directory, 'github-env');
  const metadataFile = join(directory, 'metadata-calls');
  const buildFile = join(directory, 'build-calls');
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
    set -euo pipefail
    source "$SELECTOR_SCRIPT"
    screenshot_xcode_version() {
      printf '%s\\n' "$1" >> "$METADATA_CALLS"
      cat "$1/fixture-version"
    }
    xcodebuild() {
      printf '%s\\n' "$DEVELOPER_DIR" >> "$BUILD_CALLS"
      printf 'Fixture Xcode version\\n'
    }
    select_screenshot_xcode "$FIXTURE_APPLICATIONS"
    printf 'actual_export=%s\\n' "$DEVELOPER_DIR"
  `,
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        SELECTOR_SCRIPT: resolve('scripts/select-screenshot-xcode.sh'),
        FIXTURE_APPLICATIONS: appDirectory,
        GITHUB_ENV: environmentFile,
        METADATA_CALLS: metadataFile,
        BUILD_CALLS: buildFile,
      },
    },
  );
  return { ...result, environmentFile, metadataFile, buildFile };
}
function withApplications(test: (directory: string, applications: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-xcode-selector-'));
  const applications = join(directory, 'Applications');
  mkdirSync(applications);
  try {
    test(directory, applications);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('canonical screenshot Xcode selection', () => {
  it('rejects stable-looking symlinks to an RC before metadata reads and selects stable27.1', () => {
    withApplications((directory, applications) => {
      const stable = fixtureXcode(join(applications, 'Xcode_27.1.app'), '27.1');
      const releaseCandidate = fixtureXcode(join(applications, 'Xcode_27.2_Release_Candidate.app'), '27.2');
      const alias = join(applications, 'Xcode_27.2.0.app');
      symlinkSync(releaseCandidate, alias, 'dir');
      symlinkSync(releaseCandidate, join(applications, 'Xcode.app'), 'dir');
      const result = runSelector(directory);
      const stableCanonical = realpathSync(stable);
      const candidateCanonical = realpathSync(releaseCandidate);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(`Rejected prerelease ${alias} -> ${candidateCanonical}`);
      expect(result.stderr).toContain(`Accepted ${stable} -> ${stableCanonical} (Xcode 27.1)`);
      expect(readFileSync(result.metadataFile, 'utf8')).not.toContain(candidateCanonical);
      expect(readFileSync(result.buildFile, 'utf8')).toBe(`${stableCanonical}/Contents/Developer\n`);
      expect(readFileSync(result.environmentFile, 'utf8')).toBe(
        `DEVELOPER_DIR=${stableCanonical}/Contents/Developer\n`,
      );
      expect(result.stdout).toContain(`actual_export=${stableCanonical}/Contents/Developer`);
    });
  });
  it('fails before metadata inspection or xcodebuild when only RC aliases exist', () => {
    withApplications((directory, applications) => {
      const releaseCandidate = fixtureXcode(join(applications, 'Xcode_27.2_Release_Candidate.app'), '27.2');
      symlinkSync(releaseCandidate, join(applications, 'Xcode_27.2.0.app'), 'dir');
      const result = runSelector(directory);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('needs a release Xcode 27.1 or later');
      expect(existsSync(result.metadataFile)).toBe(false);
      expect(existsSync(result.buildFile)).toBe(false);
      expect(existsSync(result.environmentFile)).toBe(false);
    });
  });
  it('exports the physical stable app directory even when the accepted alias looks stable', () => {
    withApplications((directory, applications) => {
      const stable = fixtureXcode(join(directory, 'Installed Apps', 'Verified Xcode_27.1.app'), '27.1');
      const alias = join(applications, 'Xcode_27.1.0.app');
      symlinkSync(stable, alias, 'dir');
      const result = runSelector(directory);
      const developerDirectory = `${realpathSync(stable)}/Contents/Developer`;
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(`Accepted ${alias} -> ${realpathSync(stable)} (Xcode 27.1)`);
      expect(readFileSync(result.environmentFile, 'utf8')).toBe(`DEVELOPER_DIR=${developerDirectory}\n`);
      expect(result.stdout).toContain(`actual_export=${developerDirectory}`);
    });
  });
  it('keeps the27.1floor for an older stable default alias', () => {
    withApplications((directory, applications) => {
      const older = fixtureXcode(join(directory, 'Xcode_26.5.app'), '26.5');
      symlinkSync(older, join(applications, 'Xcode.app'), 'dir');
      const result = runSelector(directory);
      expect(result.status).toBe(1);
      expect(existsSync(result.buildFile)).toBe(false);
      expect(existsSync(result.environmentFile)).toBe(false);
    });
  });
  it('calls the sourced selector before Duo runtime inspection', () => {
    const action = readFileSync('.github/actions/ios-screenshot-shard/action.yml', 'utf8');
    const sourceIndex = action.indexOf('source "$CACHE_TOOLING_ROOT/scripts/select-screenshot-xcode.sh"');
    const selectIndex = action.indexOf('        select_screenshot_xcode', sourceIndex);
    const runtimeIndex = action.indexOf('runtimes="$(xcrun simctl list runtimes)"', sourceIndex);
    expect(sourceIndex).toBeGreaterThan(-1);
    expect(selectIndex).toBeGreaterThan(sourceIndex);
    expect(selectIndex).toBeLessThan(runtimeIndex);
  });
});
