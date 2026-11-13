import { expect, it } from 'vite-plus/test';
import {
  attestIsolatedNamespace,
  requireNamespaceReceipt,
  type NamespaceExpectation,
  type NamespaceProof,
  type NamespaceResource,
} from '../namespace-guard';
const identity = { context: 'local-test', endpoint: 'unix:///var/run/docker.sock', daemonId: 'daemon-owned-6975' };
const nonce = 'a'.repeat(32);
const image = `sha256:${'c'.repeat(64)}`;
const expected: NamespaceExpectation = {
  identity,
  nonce,
  networkId: 'd'.repeat(64),
  postgres: { id: '1'.repeat(64), image },
  redis: { id: '2'.repeat(64), image },
  runtime: { id: '3'.repeat(64), image },
};
function resource(service: 'postgres' | 'redis' | 'runtime'): NamespaceResource {
  return {
    ...expected[service],
    name: `/boardsesh-auth-rehearsal-${service}-${nonce}`,
    nonce,
    running: true,
    networkMode: service === 'postgres' ? expected.networkId : `container:${expected.postgres.id}`,
    networkIds: service === 'postgres' ? [expected.networkId] : [],
    publishedBindings: 0,
    requestedBindings: 0,
    bindMounts: 0,
    privileged: false,
    dns: service === 'postgres' ? ['127.0.0.1'] : [],
    readOnly: service === 'runtime',
    capDrop: service === 'runtime' ? ['ALL'] : [],
    capAdd: [],
  };
}
function proof(): NamespaceProof {
  return {
    identity,
    internal: true,
    networkId: expected.networkId,
    networkNonce: nonce,
    networkMemberIds: [expected.postgres.id],
    postgres: resource('postgres'),
    redis: resource('redis'),
    runtime: resource('runtime'),
    postgresNamespace: 'net:[12345]',
    runtimeNamespace: 'net:[12345]',
  };
}
it('attests only fresh owned shared namespace and rejects copied receipt', () => {
  const receipt = attestIsolatedNamespace(expected, proof());
  expect(() => requireNamespaceReceipt(receipt)).not.toThrow();
  expect(() => requireNamespaceReceipt({ ...receipt })).toThrow('OWNED_NAMESPACE_RECEIPT_REQUIRED');
});
it.each([
  { internal: false },
  { networkMemberIds: [expected.postgres.id, '9'.repeat(64)] },
  { identity: { ...identity, daemonId: 'changed-daemon-6975' } },
  { runtime: { ...resource('runtime'), id: '9'.repeat(64) } },
  { runtime: { ...resource('runtime'), image: `sha256:${'f'.repeat(64)}` } },
  { redis: { ...resource('redis'), nonce: 'f'.repeat(32) } },

  { networkNonce: 'b'.repeat(32) },
  { runtimeNamespace: 'net:[999]' },
  { runtime: { ...resource('runtime'), networkMode: 'host' } },
  { redis: { ...resource('redis'), networkMode: 'bridge' } },
  { runtime: { ...resource('runtime'), publishedBindings: 1 } },
  { runtime: { ...resource('runtime'), requestedBindings: 1 } },
  { runtime: { ...resource('runtime'), bindMounts: 1 } },
  { runtime: { ...resource('runtime'), privileged: true } },
  { runtime: { ...resource('runtime'), capAdd: ['NET_ADMIN'] } },
  { runtime: { ...resource('runtime'), capDrop: [] } },
  { runtime: { ...resource('runtime'), readOnly: false } },
  { postgres: { ...resource('postgres'), dns: ['192.0.2.1'] } },
  { postgres: { ...resource('postgres'), networkIds: [expected.networkId, '9'.repeat(64)] } },
])('refuses unisolated or unowned metadata before runtime execution: %j', (mutation) => {
  let executions = 0;
  expect(() => {
    attestIsolatedNamespace(expected, { ...proof(), ...mutation });
    executions++;
  }).toThrow();
  expect(executions).toBe(0);
});
