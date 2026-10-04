/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { isDeployRoutedRunsOn, isRoutedRunsOn, withoutCommentLines } from './helpers/workflow-yaml';

/**
 * Contract tests for the Connect IQ pipeline (.github/workflows/garmin-*.yml).
 *
 * The Garmin app sits outside the vp toolchain, has no package.json, and is not
 * a pnpm workspace member, so `vp test --changed` can never relate a Monkey C or
 * workflow edit to a spec. These assertions are the only automated guard on the
 * workflow triggers, executable release-gate decisions, the device list that
 * decides what ships, and the rule that PR builds never touch the signing key.
 */

const CI_PATH = '.github/workflows/garmin-ci.yml';
const RELEASE_PATH = '.github/workflows/garmin-release.yml';
const ACTION_PATH = '.github/actions/connectiq-sdk/action.yml';
const MANIFEST_PATH = 'garmin/manifest.xml';
const DEVICES_PATH = 'garmin/release-devices.txt';
const GATE_PATH = 'scripts/garmin-gate.sh';
const gateSandboxes: string[] = [];

const ciSource = readFileSync(CI_PATH, 'utf8');
const releaseSource = readFileSync(RELEASE_PATH, 'utf8');
const manifestSource = readFileSync(MANIFEST_PATH, 'utf8');

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function createGateSandbox(): {
  binDirectory: string;
  runnerTemp: string;
  commandLog: string;
  ghLog: string;
  runsFile: string;
  workflowFile: string;
  checkedOutSha: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-garmin-gate-'));
  gateSandboxes.push(directory);
  const binDirectory = join(directory, 'bin');
  const runnerTemp = join(directory, 'runner-temp');
  mkdirSync(binDirectory);
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, 'developer_key'), 'synthetic-key');

  const commandLog = join(directory, 'commands.log');
  const ghLog = join(directory, 'gh.log');
  const runsFile = join(directory, 'runs.json');
  const workflowFile = join(directory, 'workflow.json');
  const checkedOutSha = 'a'.repeat(40);
  writeFileSync(
    workflowFile,
    JSON.stringify({
      id: 812,
      name: 'Garmin CI',
      path: '.github/workflows/garmin-ci.yml',
      state: 'active',
    }),
  );
  writeFileSync(runsFile, JSON.stringify({ workflow_runs: [] }));

  writeExecutable(
    join(binDirectory, 'monkeyc'),
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$GARMIN_TEST_COMMAND_LOG"
if [[ "$*" == *' -t' ]]; then
  target=test
elif [[ "$*" == *'monkey-staging.jungle'* ]]; then
  target=staging
else
  target=normal
fi
if [[ "$target" == normal ]]; then
  for ((warning = 0; warning < MONKEYC_TEST_WARNINGS; warning += 1)); do
    printf 'WARNING synthetic warning %s\n' "$warning"
  done
fi
if [[ "\${MONKEYC_TEST_FAIL_TARGET:-}" == "$target" ]]; then
  exit 17
fi
`,
  );
  writeExecutable(
    join(binDirectory, 'git'),
    `#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$*" == 'rev-parse HEAD' ]] || exit 2
printf '%s\n' "$GARMIN_TEST_CHECKED_OUT_SHA"
`,
  );
  writeExecutable(
    join(binDirectory, 'gh'),
    `#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1" == api ]] || exit 2
printf '%s\n' "$2" >> "$GARMIN_TEST_GH_LOG"
case "$2" in
  repos/boardsesh/boardsesh/actions/workflows/garmin-ci.yml)
    if [[ "\${GARMIN_TEST_FAIL_WORKFLOW_LOOKUP:-}" == 1 ]]; then
      exit 6
    fi
    cat "$GARMIN_TEST_WORKFLOW_FILE"
    ;;
  'repos/boardsesh/boardsesh/actions/workflows/'*'/runs?'*)
    cat "$GARMIN_TEST_RUNS_FILE"
    ;;
  *)
    printf 'unexpected GitHub API route: %s\n' "$2" >&2
    exit 2
    ;;
esac
`,
  );
  writeExecutable(
    join(binDirectory, 'sleep'),
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$GARMIN_TEST_SLEEP_LOG"
`,
  );

  return { binDirectory, runnerTemp, commandLog, ghLog, runsFile, workflowFile, checkedOutSha };
}

function runGate(
  sandbox: ReturnType<typeof createGateSandbox>,
  mode: 'compile' | 'release',
  overrides: Record<string, string> = {},
) {
  return spawnSync('bash', [resolve(GATE_PATH), mode], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${sandbox.binDirectory}${delimiter}${process.env.PATH ?? ''}`,
      RUNNER_TEMP: sandbox.runnerTemp,
      GARMIN_TEST_COMMAND_LOG: sandbox.commandLog,
      GARMIN_TEST_GH_LOG: sandbox.ghLog,
      GARMIN_TEST_SLEEP_LOG: join(sandbox.runnerTemp, 'sleep.log'),
      GARMIN_TEST_RUNS_FILE: sandbox.runsFile,
      GARMIN_TEST_WORKFLOW_FILE: sandbox.workflowFile,
      GARMIN_TEST_CHECKED_OUT_SHA: sandbox.checkedOutSha,
      MONKEYC_TEST_WARNINGS: '1',
      MONKEYC_TEST_FAIL_TARGET: '',
      CIQ_DEVICE: 'fenix7',
      CIQ_WARNING_BASELINE: '1',
      GITHUB_SHA: sandbox.checkedOutSha,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REPOSITORY: 'boardsesh/boardsesh',
      GITHUB_REF: 'refs/heads/main',
      GH_TOKEN: 'synthetic-token',
      GARMIN_CI_GATE_MAX_POLL_ATTEMPTS: '2',
      ...overrides,
    },
  });
}

function ciRun(
  sandbox: ReturnType<typeof createGateSandbox>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 91,
    workflow_id: 812,
    head_sha: sandbox.checkedOutSha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    created_at: '2026-10-04T10:00:00Z',
    run_started_at: '2026-10-04T10:00:01Z',
    ...overrides,
  };
}

afterEach(() => {
  for (const sandbox of gateSandboxes.splice(0)) {
    if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
  }
});

/** Product ids declared in the manifest — the set a build can legally target. */
function manifestProducts(): string[] {
  return [...manifestSource.matchAll(/<iq:product\s+id="([^"]+)"/g)].map(([, id]) => id);
}

/** Product ids we publish a .prg for, ignoring comments and blank lines. */
function releaseDevices(): string[] {
  return readFileSync(DEVICES_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

describe('garmin workflow path filters', () => {
  it.each([
    [CI_PATH, ciSource],
    [RELEASE_PATH, releaseSource],
  ])('%s only triggers on garmin/ and on itself', (path, source) => {
    expect(source).toContain("- 'garmin/**'");
    // Editing the workflow must re-run it, or a broken trigger ships unnoticed.
    // Repo-wide convention; see firmware-build.yml and hold-detector-image.yml.
    expect(source).toContain(`- '${path}'`);
    // Both workflows get their SDK from the shared composite action, so a change
    // there has to retrigger both -- not just whichever one remembered to list it.
    expect(source).toContain(`- '${ACTION_PATH}'`);
  });

  it('never adds a garmin filter to ci.yml', () => {
    // ci.yml's `changes` job hardcodes every output to 'true' on push, so a
    // Garmin job there would compile on every push to main — the opposite of
    // "only run when the Garmin app has changed".
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).not.toContain('garmin/**');
  });

  it('publishes only from main, never from a pull request', () => {
    const triggers = releaseSource.slice(0, releaseSource.indexOf('jobs:'));
    expect(triggers).toContain('branches: [main]');
    expect(triggers).not.toContain('pull_request');
  });
});

describe('garmin gate coverage', () => {
  it('runs on pushes to main, not only on pull requests', () => {
    // "Require CI on main" carries only required_status_checks -- no
    // pull-request requirement -- so a direct push, revert or force-push to main
    // is possible. Without this the release would publish a build that never
    // went through the gate. Same shape as firmware-tests.yml.
    const triggers = ciSource.slice(0, ciSource.indexOf('concurrency:'));
    expect(triggers).toContain('branches: [main]');
    expect(triggers).toContain('pull_request:');
  });

  it('does not skip itself on a push while guarding fork PRs', () => {
    // github.event.pull_request is null on a push, so the fork comparison alone
    // would evaluate false and skip the job on main -- silently undoing the
    // push trigger above.
    expect(ciSource).toContain("github.event_name != 'pull_request' ||");
  });

  it('reruns the release gate when its workflow or shared gate changes', () => {
    expect(ciSource.match(/- '\.github\/workflows\/garmin-release\.yml'/g)).toHaveLength(2);
    expect(ciSource.match(/- 'scripts\/garmin-gate\.sh'/g)).toHaveLength(2);
  });
});

describe('executable Garmin compile gate', () => {
  it('stops before staging when the warning count exceeds the baseline', () => {
    const sandbox = createGateSandbox();
    const result = runGate(sandbox, 'compile', { MONKEYC_TEST_WARNINGS: '2' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('emitted 2 warnings, up from 1');
    expect(readFileSync(sandbox.commandLog, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('stops before the unit-test target when staging compilation fails', () => {
    const sandbox = createGateSandbox();
    const result = runGate(sandbox, 'compile', { MONKEYC_TEST_FAIL_TARGET: 'staging' });

    expect(result.status).not.toBe(0);
    expect(readFileSync(sandbox.commandLog, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('fails when the unit-test target compilation fails', () => {
    const sandbox = createGateSandbox();
    const result = runGate(sandbox, 'compile', { MONKEYC_TEST_FAIL_TARGET: 'test' });

    expect(result.status).not.toBe(0);
    expect(readFileSync(sandbox.commandLog, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('qualifies all three compile targets before succeeding', () => {
    const sandbox = createGateSandbox();
    const result = runGate(sandbox, 'compile');
    const commands = readFileSync(sandbox.commandLog, 'utf8').trim().split('\n');

    expect(result.status).toBe(0);
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain('fenix7');
    expect(commands[1]).toContain('monkey-staging.jungle');
    expect(commands[2]).toContain('-t');
  });
});

describe('executable Garmin release gate', () => {
  it('allows a successful run for the checked-out exact main SHA', () => {
    const sandbox = createGateSandbox();
    writeFileSync(sandbox.runsFile, JSON.stringify({ workflow_runs: [ciRun(sandbox)] }));

    const result = runGate(sandbox, 'release');
    const apiCalls = readFileSync(sandbox.ghLog, 'utf8');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('completed successfully');
    expect(apiCalls).toContain(`head_sha=${sandbox.checkedOutSha}&per_page=100`);
    expect(apiCalls).toContain('branch=main&event=push');
  });

  it('refuses a newer failed rerun instead of falling back to an older pass', () => {
    const sandbox = createGateSandbox();
    writeFileSync(
      sandbox.runsFile,
      JSON.stringify({
        workflow_runs: [
          ciRun(sandbox, { run_attempt: 1, run_started_at: '2026-10-04T10:00:01Z' }),
          ciRun(sandbox, {
            conclusion: 'failure',
            run_attempt: 2,
            run_started_at: '2026-10-04T10:10:01Z',
          }),
        ],
      }),
    );

    const result = runGate(sandbox, 'release');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("attempt 2 concluded 'failure'");
  });

  it('does not accept an older pass while the newest exact-SHA run is pending', () => {
    const sandbox = createGateSandbox();
    writeFileSync(
      sandbox.runsFile,
      JSON.stringify({
        workflow_runs: [
          ciRun(sandbox, {
            status: 'in_progress',
            conclusion: null,
            run_attempt: 1,
            id: 101,
            created_at: '2026-10-04T10:00:00Z',
            run_started_at: null,
          }),
          ciRun(sandbox, {
            id: 100,
            run_started_at: '2026-10-04T10:00:00Z',
          }),
        ],
      }),
    );

    const result = runGate(sandbox, 'release', {
      GARMIN_CI_GATE_MAX_POLL_ATTEMPTS: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('run 101 attempt 1 is in_progress');
    expect(result.stderr).toContain('refusing to publish');
  });

  it('uses creation order when an older run starts after a newer run is queued', () => {
    const sandbox = createGateSandbox();
    writeFileSync(
      sandbox.runsFile,
      JSON.stringify({
        workflow_runs: [
          ciRun(sandbox, {
            id: 100,
            created_at: '2026-10-04T10:00:00Z',
            run_started_at: '2026-10-04T10:30:00Z',
          }),
          ciRun(sandbox, {
            id: 101,
            status: 'queued',
            conclusion: null,
            created_at: '2026-10-04T10:10:00Z',
            run_started_at: null,
          }),
        ],
      }),
    );

    const result = runGate(sandbox, 'release', {
      GARMIN_CI_GATE_MAX_POLL_ATTEMPTS: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('run 101 attempt 1 is queued');
    expect(result.stderr).toContain('refusing to publish');
  });

  it('refuses a same-second newer failure instead of accepting an older pass', () => {
    const sandbox = createGateSandbox();
    writeFileSync(
      sandbox.runsFile,
      JSON.stringify({
        workflow_runs: [ciRun(sandbox, { id: 100 }), ciRun(sandbox, { id: 101, conclusion: 'failure' })],
      }),
    );

    const result = runGate(sandbox, 'release', {
      GARMIN_CI_GATE_MAX_POLL_ATTEMPTS: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("run 101 attempt 1 concluded 'failure'");
  });

  it('accepts the same-second newest successful run after an older failure', () => {
    const sandbox = createGateSandbox();
    writeFileSync(
      sandbox.runsFile,
      JSON.stringify({
        workflow_runs: [ciRun(sandbox, { id: 100, conclusion: 'failure' }), ciRun(sandbox, { id: 101 })],
      }),
    );

    const result = runGate(sandbox, 'release');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Garmin CI run 101 attempt 1 completed successfully');
  });

  it('refuses matching run data that cannot be ordered safely', () => {
    const sandbox = createGateSandbox();
    const runWithoutId = ciRun(sandbox);
    delete runWithoutId.id;
    writeFileSync(sandbox.runsFile, JSON.stringify({ workflow_runs: [runWithoutId] }));

    const result = runGate(sandbox, 'release', {
      GARMIN_CI_GATE_MAX_POLL_ATTEMPTS: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('without valid ordering metadata');
  });

  it('refuses a stale SHA returned by the run lookup', () => {
    const sandbox = createGateSandbox();
    writeFileSync(
      sandbox.runsFile,
      JSON.stringify({
        workflow_runs: [ciRun(sandbox, { head_sha: 'b'.repeat(40) })],
      }),
    );

    const result = runGate(sandbox, 'release', {
      GARMIN_CI_GATE_MAX_POLL_ATTEMPTS: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no completed successful Garmin CI run');
  });

  it('fails closed when the Garmin workflow identity cannot be read', () => {
    const sandbox = createGateSandbox();
    const result = runGate(sandbox, 'release', { GARMIN_TEST_FAIL_WORKFLOW_LOOKUP: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not look up the Garmin CI workflow identity');
    expect(readFileSync(sandbox.ghLog, 'utf8')).toContain('repos/boardsesh/boardsesh/actions/workflows/garmin-ci.yml');
  });

  it('rejects an unexpected Garmin workflow identity', () => {
    const sandbox = createGateSandbox();
    writeFileSync(
      sandbox.workflowFile,
      JSON.stringify({
        id: 812,
        name: 'Different workflow',
        path: '.github/workflows/garmin-ci.yml',
        state: 'active',
      }),
    );

    const result = runGate(sandbox, 'release');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('workflow identity is missing, inactive, or unexpected');
    expect(readFileSync(sandbox.ghLog, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('requires the checkout to match the main push or dispatch SHA', () => {
    const sandbox = createGateSandbox();
    const result = runGate(sandbox, 'release', {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_SHA: 'b'.repeat(40),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match workflow SHA');
    expect(existsSync(sandbox.ghLog)).toBe(false);
  });

  it('applies the same exact-source gate to manual dispatch on main', () => {
    const sandbox = createGateSandbox();
    writeFileSync(sandbox.runsFile, JSON.stringify({ workflow_runs: [ciRun(sandbox)] }));

    const result = runGate(sandbox, 'release', { GITHUB_EVENT_NAME: 'workflow_dispatch' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('completed successfully');
  });

  it('rejects manual dispatch away from main before querying GitHub', () => {
    const sandbox = createGateSandbox();
    const result = runGate(sandbox, 'release', {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/feature',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('only allows refs/heads/main');
    expect(existsSync(sandbox.ghLog)).toBe(false);
  });

  it('runs before SDK access, signing-key decode, and publication', () => {
    const gateStep = releaseSource.indexOf('run: bash scripts/garmin-gate.sh release');
    const sdkStep = releaseSource.indexOf('uses: ./.github/actions/connectiq-sdk');
    const keyStep = releaseSource.indexOf('name: Decode the developer signing key');
    const publishStep = releaseSource.indexOf('name: Publish the rolling sideload release');

    expect(gateStep).toBeGreaterThan(-1);
    expect(gateStep).toBeLessThan(sdkStep);
    expect(gateStep).toBeLessThan(keyStep);
    expect(gateStep).toBeLessThan(publishStep);
  });
});

describe('garmin release provenance', () => {
  it('refuses to publish from anywhere but main', () => {
    // A workflow_dispatch from a feature branch would overwrite the garmin-latest
    // assets and force-move the tag that every install URL points at.
    expect(releaseSource).toContain("if: github.ref != 'refs/heads/main'");
  });

  it('will not prune assets unless the checksums are in the publish dir', () => {
    // The prune loop deletes anything not in $release. SHA256SUMS.txt is only
    // spared because the build step writes it there; assert it rather than
    // trusting step order.
    expect(releaseSource).toContain('refusing to prune assets');
  });
});

describe('garmin signing-key boundary', () => {
  it('keeps the real developer key out of PR builds', () => {
    // The Connect IQ Store rejects an update signed with a different key, so the
    // key is irreplaceable. PR builds are never installed or distributed and so
    // sign with a throwaway key minted in the job.
    expect(ciSource).not.toContain('GARMIN_DEVELOPER_KEY_BASE64');
    expect(ciSource).toContain('openssl genrsa');
    expect(releaseSource).toContain('GARMIN_DEVELOPER_KEY_BASE64');
  });

  it('skips the PR compile for forks rather than leaking secrets to them', () => {
    expect(ciSource).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  it('names the missing configuration instead of failing obscurely', () => {
    // With no `Garmin` environment every input is empty, the download URL is
    // built from empty version strings, and the only symptom is
    // `gzip: stdin: unexpected end of file`. The preflight says what is missing.
    const action = readFileSync(ACTION_PATH, 'utf8');
    for (const name of [
      'vars.CIQ_SDK_VERSION',
      'vars.CIQ_SDK_MANAGER_VERSION',
      'vars.CIQ_AGREEMENT_HASH',
      'secrets.GARMIN_USERNAME',
      'secrets.GARMIN_PASSWORD',
    ]) {
      expect(action).toContain(name);
    }
  });

  it('never caches the SDK manager config, which holds a live session token', () => {
    const action = readFileSync(ACTION_PATH, 'utf8');
    // Caches are restorable by fork PRs from the base branch. The config lives in
    // $RUNNER_TEMP and is shredded; only ~/.Garmin/ConnectIQ is cached.
    // Every cache path in the action, not just the first: matching only the
    // first would silently pass on the wrong step if a second cache is added.
    const cachedPaths = withoutCommentLines(action)
      .filter((line) => line.trim().startsWith('path:'))
      .map((line) => line.trim());
    expect(cachedPaths).toEqual(['path: ~/.Garmin/ConnectIQ']);
    expect(action).toContain('ciq_config="$RUNNER_TEMP/ciq-config.yaml"');
  });
});

describe('garmin release publication', () => {
  it('updates the release in place rather than deleting it first', () => {
    // garmin-latest is the only way to install the app. Deleting before
    // recreating means a publish that fails halfway leaves every climber with
    // no download at all, so the workflow clobbers assets onto the existing
    // release instead.
    expect(releaseSource).not.toContain('gh release delete garmin-latest');
    expect(releaseSource).toContain('gh release upload');
    expect(releaseSource).toContain('--clobber');
    // ...and prunes assets for watches that have left release-devices.txt,
    // which --clobber alone would strand on the release forever.
    expect(releaseSource).toContain('gh release delete-asset');
  });

  it('verifies published assets against the checksums it built', () => {
    expect(releaseSource).toContain('sha256sum -c');
  });
});

describe('garmin SDK manager invocation', () => {
  it('uses the flag name the CLI actually has', () => {
    // v0.8.4 exposes `-H, --agreement-hash`. `--acceptance-hash`, which upstream
    // prose uses in places, is rejected as an unknown flag.
    // Comment lines stripped: the action deliberately NAMES the wrong flag in a
    // comment so the next reader does not reintroduce it.
    const live = withoutCommentLines(readFileSync(ACTION_PATH, 'utf8')).join('\n');
    expect(live).toContain('--agreement-hash=');
    expect(live).not.toContain('--acceptance-hash');
  });

  it('creates the config file before passing --config', () => {
    // --config on a path that does not exist fails with "no such file or
    // directory" before doing anything else.
    const action = readFileSync(ACTION_PATH, 'utf8');
    expect(action).toContain(': > "$ciq_config"');
  });
});

describe('garmin SDK login', () => {
  it('cannot stall on the interactive SSO fallback', () => {
    // `login --help`: credentials come from GARMIN_USERNAME / GARMIN_PASSWORD,
    // but on bad ones the CLI drops to an interactive Garmin SSO prompt. In CI
    // that blocks until the job timeout with nothing useful logged.
    const action = readFileSync(ACTION_PATH, 'utf8');
    expect(action).toContain('login </dev/null');
    expect(action).toMatch(/timeout \d+ "\$ciq_bin"/);
  });
});

describe('garmin release device list', () => {
  it('lists at least one device', () => {
    expect(releaseDevices().length).toBeGreaterThan(0);
  });

  it('only names products declared in the manifest', () => {
    const declared = new Set(manifestProducts());
    const unknown = releaseDevices().filter((device) => !declared.has(device));
    expect(unknown).toEqual([]);
  });

  it('has no duplicates', () => {
    const devices = releaseDevices();
    expect(devices).toEqual([...new Set(devices)]);
  });
});

describe('garmin runner routing', () => {
  it.each([
    [CI_PATH, ciSource],
    [RELEASE_PATH, releaseSource],
  ])('%s stays on GitHub-hosted runners', (_path, source) => {
    // Both jobs read secrets, and ci-self-hosted-secret-boundary.test.ts forbids
    // that on anything that can land on the homelab fleet. The routing
    // expression is also allowlisted per-job by ci-runner-routing.test.ts, so
    // copying it here would fail that spec.
    const lines = withoutCommentLines(source);
    expect(lines.some(isRoutedRunsOn)).toBe(false);
    expect(lines.some(isDeployRoutedRunsOn)).toBe(false);
    expect(lines.some((line) => line.includes('self-hosted'))).toBe(false);
  });
});
