import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vite-plus/test';
import { createIsolatedTarget, requireCreatedIsolatedTarget } from '../isolated-target';
import { REHEARSAL_CONTAINER_LABEL } from '../target-guard';
import type { DockerCommand } from '../docker';
vi.mock('../runtime-image', () => ({ requireBuiltRuntimeImage: vi.fn() }));
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
}));
const identity = { context: 'local-test', endpoint: 'unix:///var/run/docker.sock', daemonId: 'daemon-owned-6975' };
const networkId = 'd'.repeat(64);
const imageId = `sha256:${'c'.repeat(64)}`;
function fixture(extraMember = false) {
  let nonce = '';
  let corruptRuntime = false;
  const services = new Map<string, string>();
  const docker = vi.fn<DockerCommand>(async (original) => {
    const args = original[0] === '--host' ? original.slice(2) : original;
    if (args[0] === 'info') return JSON.stringify(identity.daemonId);
    if (args[0] === 'image') return imageId;
    if (args[0] === 'network' && args[1] === 'create') {
      nonce = args[args.indexOf('--label') + 1].split('=')[1];
      return networkId;
    }
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1];
      const service = name.includes('-postgres-') ? 'postgres' : name.includes('-redis-') ? 'redis' : 'runtime';
      const id = (service === 'postgres' ? '1' : service === 'redis' ? '2' : '3').repeat(64);
      services.set(id, service);
      return id;
    }
    if (args[0] === 'network' && args[1] === 'inspect')
      return JSON.stringify([
        {
          Id: networkId,
          Internal: true,
          Labels: { [REHEARSAL_CONTAINER_LABEL]: nonce },
          Containers: { ['1'.repeat(64)]: {}, ...(extraMember ? { ['9'.repeat(64)]: {} } : {}) },
        },
      ]);
    if (args[0] === 'inspect') {
      const id = args[1];
      const service = services.get(id);
      return JSON.stringify([
        {
          Id: id,
          Image: imageId,
          Name: `/boardsesh-auth-rehearsal-${service}-${nonce}`,
          State: { Running: true },
          Mounts: [],
          Config: {
            Labels: { [REHEARSAL_CONTAINER_LABEL]: service === 'runtime' && corruptRuntime ? 'changed' : nonce },
          },
          HostConfig: {
            NetworkMode: service === 'postgres' ? networkId : `container:${'1'.repeat(64)}`,
            PortBindings: {},
            Privileged: false,
            Dns: service === 'postgres' ? ['127.0.0.1'] : [],
            ReadonlyRootfs: service === 'runtime',
            CapDrop: service === 'runtime' ? ['ALL'] : [],
            CapAdd: [],
          },
          NetworkSettings: { Networks: service === 'postgres' ? { owned: { NetworkID: networkId } } : {}, Ports: {} },
        },
      ]);
    }
    if (args[0] === 'exec') return 'net:[12345]';
    if (args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm')) return '';
    throw new Error('UNEXPECTED_FIXTURE_COMMAND');
  });
  return {
    docker,
    corrupt: () => {
      corruptRuntime = true;
    },
  };
}
it('rejects an extra unowned internal-network endpoint before returning a target capability', async () => {
  const { docker } = fixture(true);
  let refused = false;
  try {
    await createIsolatedTarget({ identity, imageId }, docker);
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
});
it('returns only a deeply frozen original target and checks all resources before disposal', async () => {
  const { docker, corrupt } = fixture();
  const target = await createIsolatedTarget({ identity, imageId }, docker);
  const auditWrites = vi.mocked(writeFileSync).mock.calls;
  expect(auditWrites.length > 0).toBe(true);
  for (const [, serialized, options] of auditWrites) {
    if (typeof serialized !== 'string') throw new Error('AUDIT_JSON_REQUIRED');
    expect(serialized.includes(target.secrets.postgresPassword)).toBe(false);
    expect(serialized.includes(target.secrets.redisPassword)).toBe(false);
    expect(serialized.includes(target.secrets.signingSecret)).toBe(false);
    expect(options).toEqual({ mode: 0o600, flag: 'wx' });
  }
  expect(Object.isFrozen(target.expected)).toBe(true);
  expect(Object.isFrozen(target.expected.runtime)).toBe(true);
  expect(() => requireCreatedIsolatedTarget({ ...target })).toThrow('OWNED_ISOLATED_TARGET_RECEIPT_REQUIRED');
  corrupt();
  await expect(target.dispose()).rejects.toThrow();
  expect(docker.mock.calls.some(([args]) => args.includes('rm'))).toBe(false);
});
