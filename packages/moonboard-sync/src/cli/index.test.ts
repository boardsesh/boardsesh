import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('../../', import.meta.url));
const packageManifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('MoonBoard daemon command', () => {
  it.each([
    { username: '', password: 'test-password' },
    { username: 'sync@example.com', password: '' },
  ])('fails visibly when a required credential is missing: %j', ({ username, password }) => {
    // Execute the actual package command, including its flags. Adding the
    // optional seed skip flag back would make this exit zero and fail the test.
    const [runner, ...daemonArguments] = packageManifest.scripts['sync:daemon'].split(/\s+/);
    expect(runner).toBe('tsx');
    const result = spawnSync(process.execPath, ['--import', 'tsx', ...daemonArguments], {
      cwd: packageDirectory,
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: '/dev/null',
        MOONBOARD_USERNAME: username,
        MOONBOARD_PASSWORD: password,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MoonBoard credentials are required');
    expect(result.stdout).not.toContain('Starting MoonBoard location sync daemon');
  });
});
