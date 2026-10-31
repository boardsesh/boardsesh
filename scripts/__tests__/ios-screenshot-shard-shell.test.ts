import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ActionStep {
  name?: string;
  shell?: string;
  env?: Record<string, string>;
  run?: string;
}

const action = parse(readFileSync('.github/actions/ios-screenshot-shard/action.yml', 'utf8')) as {
  runs: { steps: ActionStep[] };
};
const identityStep = action.runs.steps.find((step) => step.name === 'Verify prebuilt simulator app identity');

function runIdentityStep(minimumSdk: string, helperExit: number) {
  if (!identityStep?.run) throw new Error('Missing simulator app identity step');
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-cache-preflight-'));
  const executableDirectory = join(directory, 'mock bin');
  const argumentsFile = join(directory, 'node-arguments');
  const continuationFile = join(directory, 'continued');
  const toolingRoot = join(directory, 'tooling checkout');
  const cacheKey = 'cache-key-with spaces';
  mkdirSync(executableDirectory);
  writeFileSync(
    join(executableDirectory, 'node'),
    '#!/bin/bash\nprintf "%s\\0" "$@" > "$ARGUMENTS_FILE"\nexit "$HELPER_EXIT"\n',
    { mode: 0o755 },
  );
  try {
    // Run the actual YAML under the macOS runner's /bin/bash (3.2 locally).
    // The sentinel models a later command that must never run after validation fails.
    const result = spawnSync('/bin/bash', ['-c', `${identityStep.run}\nprintf passed > "$CONTINUATION_FILE"\n`], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${executableDirectory}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        APP_CACHE_KEY: cacheKey,
        CACHE_TOOLING_ROOT: toolingRoot,
        MINIMUM_SDK: minimumSdk,
        ARGUMENTS_FILE: argumentsFile,
        CONTINUATION_FILE: continuationFile,
        HELPER_EXIT: String(helperExit),
      },
    });
    return {
      ...result,
      arguments: existsSync(argumentsFile) ? readFileSync(argumentsFile, 'utf8').split('\0').slice(0, -1) : [],
      continued: existsSync(continuationFile),
      expectedArguments: [
        '--experimental-strip-types',
        `${toolingRoot}/scripts/ios-screenshot-app-cache.ts`,
        'validate',
        '--key',
        cacheKey,
        '--app',
        'packages/mobile/.app-cache/Boardsesh.app',
        ...(minimumSdk ? ['--minimum-sdk', minimumSdk] : []),
      ],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('screenshot shard simulator identity shell step', () => {
  it('keeps the Duo-only SDK27.1 floor in the actual action environment', () => {
    expect(identityStep?.shell).toBe('bash');
    expect(identityStep?.env?.MINIMUM_SDK).toBe("${{ inputs.device-slug == 'iphone-duo' && '27.1' || '' }}");
  });

  it.each([
    ['iPhone', ''],
    ['iPad', ''],
    ['Duo', '27.1'],
  ])('runs %s validation with exact quoted helper arguments', (_device, minimumSdk) => {
    const result = runIdentityStep(minimumSdk, 0);
    expect(result.status, result.stderr).toBe(0);
    expect(result.arguments).toEqual(result.expectedArguments);
    expect(result.continued).toBe(true);
  });

  it.each(['', '27.1'])('stops the shell when validation fails with minimum SDK %j', (minimumSdk) => {
    const result = runIdentityStep(minimumSdk, 23);
    expect(result.arguments).toEqual(result.expectedArguments);
    expect(result.status, result.stderr).toBe(23);
    expect(result.continued).toBe(false);
  });
});
