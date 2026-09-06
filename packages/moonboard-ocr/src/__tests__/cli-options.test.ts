/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/ENCHANTED.PNG', import.meta.url));

function invoke(command: string, ...options: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, command, fixture, ...options], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('real CLI board/profile option wiring', () => {
  it.each(['parse', 'test'])('%s rejects an unknown setup before accessing an image', (command) => {
    const result = invoke(command, '--holdsetup', '7');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported MoonBoard holdsetup');
    expect(result.stdout).not.toContain('Output written');
  });

  it.each(['parse', 'test'])('%s rejects an unknown screenshot profile', (command) => {
    const result = invoke(command, '--screenshot-profile', 'unvalidated');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Allowed choices are legacy-ios, android-pixel8pro-1.3.68');
    expect(result.stdout).not.toContain('Output written');
  });

  it('passes the Mini setup to the parser instead of defaulting to 2024', () => {
    const result = invoke('test', '--holdsetup', '19');
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('Mini screenshots require a validated Android profile');
  });

  it('passes the Android profile too, enforcing its real screenshot dimensions', () => {
    // The existing iOS fixture must fail before starting Tesseract or networking.
    const result = invoke('test', '--holdsetup', '19', '--screenshot-profile', 'android-pixel8pro-1.3.68');
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('expected 1008x2244');
    expect(result.stdout).not.toContain('Mini screenshots require');
  });
});
