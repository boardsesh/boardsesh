import { expect, it, vi } from 'vite-plus/test';
import { inspectOwnedContainer, localDockerIdentity, type DockerCommand } from '../docker';
import { REHEARSAL_CONTAINER_LABEL, type ExpectedOwnedContainer } from '../target-guard';
const identity = { context: 'local-test', endpoint: 'unix:///var/run/docker.sock', daemonId: 'daemon-owned-6975' };
const expected: ExpectedOwnedContainer = {
  service: 'postgres',
  identity,
  runNonce: 'a'.repeat(32),
  containerId: 'b'.repeat(64),
  imageId: `sha256:${'c'.repeat(64)}`,
  networkId: 'd'.repeat(64),
};
const container = {
  Id: expected.containerId,
  Image: expected.imageId,
  Name: `/boardsesh-auth-rehearsal-postgres-${expected.runNonce}`,
  State: { Running: true },
  Mounts: [],
  Config: { Labels: { [REHEARSAL_CONTAINER_LABEL]: expected.runNonce } },
  NetworkSettings: {
    Networks: { owned: { NetworkID: expected.networkId } },
    Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '35432' }] },
  },
};
const network = { Id: expected.networkId, Internal: true, Labels: { [REHEARSAL_CONTAINER_LABEL]: expected.runNonce } };

it('rejects remote Docker environment overrides before any CLI or network invocation', async () => {
  const docker = vi.fn<DockerCommand>();
  for (const environment of [
    { DOCKER_HOST: 'tcp://unreachable.invalid:2376' },
    { DOCKER_CONFIG: '/not-read' },
    { DOCKER_CERT_PATH: '/not-read' },
    { DOCKER_TLS_VERIFY: '1' },
  ]) {
    await expect(localDockerIdentity(docker, environment)).rejects.toThrow('LOCAL_DOCKER_REQUIRED');
  }
  expect(docker).not.toHaveBeenCalled();
});
it('refuses a context pointing at a tunnel before querying the daemon', async () => {
  const docker = vi
    .fn<DockerCommand>()
    .mockResolvedValueOnce('local-test')
    .mockResolvedValueOnce(JSON.stringify([{ Endpoints: { docker: { Host: 'ssh://unreachable.invalid' } } }]));
  await expect(localDockerIdentity(docker, {})).rejects.toThrow('LOCAL_DOCKER_REQUIRED');
  expect(docker.mock.calls.some(([arguments_]) => arguments_.includes('info'))).toBe(false);
});
it('pins the inspected local Unix endpoint instead of reusing a mutable context alias', async () => {
  const docker = vi
    .fn<DockerCommand>()
    .mockResolvedValueOnce('local-test')
    .mockResolvedValueOnce(JSON.stringify([{ Endpoints: { docker: { Host: identity.endpoint } } }]))
    .mockResolvedValueOnce(JSON.stringify(identity.daemonId));
  expect(await localDockerIdentity(docker, {})).toEqual(identity);
  expect(docker.mock.calls[2][0]).toEqual(['--host', identity.endpoint, 'info', '--format', '{{json .ID}}']);
});
it('proves inspected container, image, nonce, internal network and published binding before SQL construction', async () => {
  const docker = vi
    .fn<DockerCommand>()
    .mockResolvedValueOnce(JSON.stringify(identity.daemonId))
    .mockResolvedValueOnce(JSON.stringify([container]))
    .mockResolvedValueOnce(JSON.stringify([network]));
  const connect = vi.fn();
  const owned = await inspectOwnedContainer(expected, docker);
  connect(owned.endpoint);
  expect(connect).toHaveBeenCalledOnce();
  expect(
    docker.mock.calls.every(([arguments_]) => arguments_[0] === '--host' && arguments_[1] === identity.endpoint),
  ).toBe(true);
});
it.each([
  { container: { ...container, Config: { Labels: {} } } },
  {
    container: {
      ...container,
      NetworkSettings: {
        ...container.NetworkSettings,
        Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '35432' }] },
      },
    },
  },
  { network: { ...network, Internal: false } },
  { network: { ...network, Labels: {} } },
])('refuses forged Docker ownership/binding before a SQL/network factory: %j', async (mutation) => {
  const docker = vi
    .fn<DockerCommand>()
    .mockResolvedValueOnce(JSON.stringify(identity.daemonId))
    .mockResolvedValueOnce(JSON.stringify([mutation.container ?? container]))
    .mockResolvedValueOnce(JSON.stringify([mutation.network ?? network]));
  const connect = vi.fn();
  await expect(
    (async () => {
      const owned = await inspectOwnedContainer(expected, docker);
      connect(owned.endpoint);
    })(),
  ).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
});

it('rejects an additional publicly published port before minting an endpoint capability', async () => {
  const additionalPublication = {
    ...container,
    NetworkSettings: {
      ...container.NetworkSettings,
      Ports: {
        ...container.NetworkSettings.Ports,
        '15432/tcp': [{ HostIp: '0.0.0.0', HostPort: '35433' }],
      },
    },
  };
  const docker = vi
    .fn<DockerCommand>()
    .mockResolvedValueOnce(JSON.stringify(identity.daemonId))
    .mockResolvedValueOnce(JSON.stringify([additionalPublication]))
    .mockResolvedValueOnce(JSON.stringify([network]));
  const connect = vi.fn();
  await expect(
    (async () => {
      const owned = await inspectOwnedContainer(expected, docker);
      connect(owned.endpoint);
    })(),
  ).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
});
