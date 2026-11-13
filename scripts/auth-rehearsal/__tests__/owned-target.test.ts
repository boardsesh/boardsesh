import { expect, it, vi } from 'vite-plus/test';
import type { DockerCommand } from '../docker';
import { createOwnedTarget, REHEARSAL_REDIS_IMAGE } from '../owned-target';
import { REHEARSAL_CONTAINER_LABEL } from '../target-guard';

function fixture() {
  const networkId = 'd'.repeat(64);
  const imageId = `sha256:${'c'.repeat(64)}`;
  const containers = new Map<string, { service: string; nonce: string }>();
  let nonce = '';
  let corrupt: 'both' | 'redis' | undefined;
  const docker = vi.fn<DockerCommand>(async (original) => {
    const arguments_ = original[0] === '--host' ? original.slice(2) : original;
    if (arguments_[0] === 'context' && arguments_[1] === 'show') return 'local-test';
    if (arguments_[0] === 'context')
      return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
    if (arguments_[0] === 'info') return JSON.stringify('daemon-owned-6975');
    if (arguments_[0] === 'image') return imageId;
    if (arguments_[0] === 'network' && arguments_[1] === 'create') {
      nonce = arguments_[arguments_.indexOf('--label') + 1].split('=')[1];
      return networkId;
    }
    if (arguments_[0] === 'run') {
      const service = arguments_[arguments_.indexOf('--name') + 1].includes('-postgres-') ? 'postgres' : 'redis';
      const id = (service === 'postgres' ? 'a' : 'b').repeat(64);
      containers.set(id, { service, nonce });
      return id;
    }
    if (arguments_[0] === 'inspect') {
      const id = arguments_[3];
      const container = containers.get(id)!;
      return JSON.stringify([
        {
          Id: id,
          Image: imageId,
          Name: `/boardsesh-auth-rehearsal-${container.service}-${container.nonce}`,
          State: { Running: true },
          Mounts: [],
          Config: {
            Labels: {
              [REHEARSAL_CONTAINER_LABEL]: corrupt === 'both' || corrupt === container.service ? 'changed' : nonce,
            },
          },
          NetworkSettings: {
            Networks: { owned: { NetworkID: networkId } },
            Ports: {
              [container.service === 'postgres' ? '5432/tcp' : '6379/tcp']: [
                { HostIp: '127.0.0.1', HostPort: '35432' },
              ],
            },
          },
        },
      ]);
    }
    if (arguments_[0] === 'network' && arguments_[1] === 'inspect')
      return JSON.stringify([{ Id: networkId, Internal: true, Labels: { [REHEARSAL_CONTAINER_LABEL]: nonce } }]);
    if (arguments_[0] === 'rm' || (arguments_[0] === 'network' && arguments_[1] === 'rm')) return '';
    throw new Error('UNEXPECTED_FIXTURE_COMMAND');
  });
  return {
    docker,
    corrupt: (service: 'both' | 'redis' = 'both') => {
      corrupt = service;
    },
  };
}

it('creates fresh isolated resources only after immutable local image qualification', async () => {
  const { docker } = fixture();
  const target = await createOwnedTarget(docker);
  const commands = docker.mock.calls.map(([arguments_]) => arguments_);
  const run = commands.filter((arguments_) => arguments_.includes('run'));
  expect(run).toHaveLength(2);
  for (const arguments_ of run) {
    expect(arguments_).toContain('--pull=never');
    expect(arguments_).toContain('--tmpfs');
    expect(arguments_).not.toContain('--volume');
    expect(arguments_[arguments_.indexOf('--publish') + 1]).toMatch(/^127\.0\.0\.1::/);
  }
  expect(commands.findIndex((arguments_) => arguments_.includes('create'))).toBeGreaterThan(
    commands.map((arguments_) => arguments_.includes('image')).lastIndexOf(true),
  );
  await target.revalidate();
  await target.dispose();
  await expect(target.revalidate()).rejects.toThrow('OWNED_TARGET_DISPOSED');
});

it('refuses changed ownership before deleting any resource', async () => {
  const { docker, corrupt } = fixture();
  const target = await createOwnedTarget(docker);
  corrupt();
  await expect(target.dispose()).rejects.toThrow('OWNED_CONTAINER_REQUIRED');
  expect(docker.mock.calls.some(([arguments_]) => arguments_.includes('rm'))).toBe(false);
});

it('missing pinned local images refuses before creating any Docker resource', async () => {
  const { docker } = fixture();
  const guarded: DockerCommand = (arguments_, additions) => {
    if (arguments_.includes('image')) throw new Error('FIXTURE_MISSING_IMAGE');
    return docker(arguments_, additions);
  };
  await expect(createOwnedTarget(guarded)).rejects.toThrow('PINNED_LOCAL_IMAGE_REQUIRED');
  expect(docker.mock.calls.some(([arguments_]) => arguments_.includes('create') || arguments_.includes('run'))).toBe(
    false,
  );
});

it('checks the second container before deleting the first', async () => {
  const { docker, corrupt } = fixture();
  const target = await createOwnedTarget(docker);
  corrupt('redis');
  await expect(target.dispose()).rejects.toThrow('OWNED_CONTAINER_REQUIRED');
  expect(docker.mock.calls.some(([arguments_]) => arguments_.includes('rm'))).toBe(false);
});

it('qualifies Redis as well as PostgreSQL before creating the network', async () => {
  const { docker } = fixture();
  const guarded: DockerCommand = (arguments_, additions) => {
    if (arguments_.includes(REHEARSAL_REDIS_IMAGE)) throw new Error('FIXTURE_MISSING_REDIS_IMAGE');
    return docker(arguments_, additions);
  };
  await expect(createOwnedTarget(guarded)).rejects.toThrow('PINNED_LOCAL_IMAGE_REQUIRED');
  expect(docker.mock.calls.some(([arguments_]) => arguments_.includes('create') || arguments_.includes('run'))).toBe(
    false,
  );
});

it('never returns an endpoint or blindly cleans up after initial metadata refusal', async () => {
  const { docker, corrupt } = fixture();
  corrupt();
  await expect(createOwnedTarget(docker)).rejects.toThrow('OWNED_TARGET_PREPARATION_FAILED');
  expect(docker.mock.calls.some(([arguments_]) => arguments_.includes('rm'))).toBe(false);
});

it('disposal is idempotent and never removes resources twice', async () => {
  const { docker } = fixture();
  const target = await createOwnedTarget(docker);
  await target.dispose();
  const calls = docker.mock.calls.length;
  await target.dispose();
  expect(docker.mock.calls).toHaveLength(calls);
});
