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
    ['pnpm run check', 'pnpm run check'],
    ['cd packages/mobile && npm run typecheck', 'npm run typecheck'],
    ['(bun run test)', 'bun run test'],
    ['vp check; pnpm run lint', 'pnpm run lint'],
  ])('blocks raw script runners: %s', (command, blockedInvocation) => {
    const result = runHook(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(blockedInvocation);
    expect(result.stderr).toContain('Use the vp equivalent');
  });

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
    ['bunx playwright', 'bunx'],
    ['npx eslint .', 'npx'],
    ['vp check && npx prettier --check .', 'npx'],
  ])('blocks raw package executors: %s', (command, blockedInvocation) => {
    const result = runHook(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`Blocked: \`${blockedInvocation}\``);
    expect(result.stderr).toContain('vp exec');
    expect(result.stderr).toContain('vp dlx');
  });

  it.each([
    'vp install',
    'vp exec pnpm --dir packages/mobile/web-runtime install --frozen-lockfile',
    'pnpm --filter boardsesh-backend run start',
    'npx pnpm@11.22.0 --version',
    'npx --yes pnpm@11.22.0 --version',
  ])('allows sanctioned toolchain commands: %s', (command) => {
    const result = runHook(command);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
