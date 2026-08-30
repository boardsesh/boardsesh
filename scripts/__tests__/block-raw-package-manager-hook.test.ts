/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const HOOK_PATH = '.claude/hooks/block-raw-package-manager.sh';

function runHook(command: string) {
  return spawnSync('bash', [HOOK_PATH], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_input: { command } }),
  });
}

describe('block-raw-package-manager hook', () => {
  it.each([
    'pnpm install',
    'cd packages/mobile && pnpm install --frozen-lockfile',
    '(pnpm install --offline)',
    'vp check; pnpm install',
  ])('blocks raw installs: %s', (command) => {
    const result = runHook(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('pnpm install');
    expect(result.stderr).toContain('vp install');
  });

  it.each([
    'vp install',
    'vp exec pnpm --dir packages/mobile/web-runtime install --frozen-lockfile',
    'pnpm --filter boardsesh-backend run start',
  ])('allows sanctioned toolchain commands: %s', (command) => {
    const result = runHook(command);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
