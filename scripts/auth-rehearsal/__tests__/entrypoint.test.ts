import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vite-plus/test';
import { createIsolatedTarget, requireCreatedIsolatedTarget } from '../isolated-target';
import type { DockerCommand } from '../docker';

it('actual entrypoint rejects target URL input before poisoned Docker environment can be consulted', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      createRequire(import.meta.url).resolve('tsx'),
      fileURLToPath(new URL('../index.ts', import.meta.url)),
      'postgres://unreachable.invalid/never',
    ],
    {
      env: { PATH: process.env.PATH, DOCKER_HOST: 'tcp://unreachable.invalid:2376' },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe('REHEARSAL_ARGUMENTS_REFUSED');
});
it('rejects a caller-created image receipt before any Docker operation', async () => {
  const docker = vi.fn<DockerCommand>();
  await expect(
    createIsolatedTarget(
      {
        imageId: `sha256:${'a'.repeat(64)}`,
        identity: {
          context: 'local-test',
          endpoint: 'unix:///var/run/docker.sock',
          daemonId: 'daemon-owned-6975',
        },
      },
      docker,
    ),
  ).rejects.toThrow('OWNED_RUNTIME_BUILD_RECEIPT_REQUIRED');
  expect(docker).not.toHaveBeenCalled();
});
it('rejects a caller-created execution target', () => {
  expect(() => requireCreatedIsolatedTarget({})).toThrow('OWNED_ISOLATED_TARGET_RECEIPT_REQUIRED');
});
it.each([{ arguments_: [] }, { arguments_: ['full'] }])(
  'default/full is not-ready before any Docker or SQL: %j',
  ({ arguments_ }) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        fileURLToPath(new URL('../index.ts', import.meta.url)),
        ...arguments_,
      ],
      {
        env: { PATH: process.env.PATH, DOCKER_HOST: 'tcp://unreachable.invalid:2376' },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('FULL_AUTH_REHEARSAL_NOT_READY');
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ready: false, qualification: 'not-ready' });
  },
);
